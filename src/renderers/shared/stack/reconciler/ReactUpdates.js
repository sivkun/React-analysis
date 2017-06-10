/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactUpdates
 */

'use strict';

var PooledClass = require('PooledClass');
var ReactFeatureFlags = require('ReactFeatureFlags');
var ReactReconciler = require('ReactReconciler');
var Transaction = require('Transaction');

var invariant = require('invariant');

var dirtyComponents = [];
var updateBatchNumber = 0;

var batchingStrategy = null;

function ensureInjected() {
  invariant(
    ReactUpdates.ReactReconcileTransaction && batchingStrategy,
    'ReactUpdates: must inject a reconcile transaction class and batching ' +
    'strategy'
  );
}

var NESTED_UPDATES = {
  initialize: function() {
    this.dirtyComponentsLength = dirtyComponents.length;
  },
  close: function() {
    if (this.dirtyComponentsLength !== dirtyComponents.length) {
      // Additional updates were enqueued by componentDidUpdate handlers or
      // similar; before our own UPDATE_QUEUEING wrapper closes, we want to run
      // these new updates so that if A's componentDidUpdate calls setState on
      // B, B will update before the callback A's updater provided when calling
      // setState.
      dirtyComponents.splice(0, this.dirtyComponentsLength);
      flushBatchedUpdates();
    } else {
      dirtyComponents.length = 0;
    }
  },
};

var TRANSACTION_WRAPPERS = [NESTED_UPDATES];

function ReactUpdatesFlushTransaction() {
  this.reinitializeTransaction();
  this.dirtyComponentsLength = null;
  this.reconcileTransaction = ReactUpdates.ReactReconcileTransaction.getPooled(
    /* useCreateElement */ true
  );
}

Object.assign(
  ReactUpdatesFlushTransaction.prototype,
  Transaction,
  {
    getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    },

    destructor: function() { //该方法是为PooledClass添加的回调
      this.dirtyComponentsLength = null;
      ReactUpdates.ReactReconcileTransaction.release(this.reconcileTransaction);
      this.reconcileTransaction = null;
    },

    perform: function(method, scope, a) {
      // Essentially calls `this.reconcileTransaction.perform(method, scope, a)`
      // with this transaction's wrappers around it.
      return Transaction.perform.call(
        this,
        this.reconcileTransaction.perform,
        this.reconcileTransaction,
        method,
        scope,
        a
      );
    },
  }

);


PooledClass.addPoolingTo(ReactUpdatesFlushTransaction);

function batchedUpdates(callback, a, b, c, d, e) {
  ensureInjected();
  return batchingStrategy.batchedUpdates(callback, a, b, c, d, e);
}

/**
 * Array comparator for ReactComponents by mount ordering.
 *
 * @param {ReactComponent} c1 first component you're comparing
 * @param {ReactComponent} c2 second component you're comparing
 * @return {number} Return value usable by Array.prototype.sort().
 */
function mountOrderComparator(c1, c2) {
  return c1._mountOrder - c2._mountOrder;
}
/**
 * 真正的运行批量更新
 *
 * @param transaction
 */
function runBatchedUpdates(transaction) {
  var len = transaction.dirtyComponentsLength;
  invariant(
    len === dirtyComponents.length,
    'Expected flush transaction\'s stored dirty-components length (%s) to ' +
    'match dirty-components array length (%s).',
    len,
    dirtyComponents.length
  );

  // Since reconciling a component higher in the owner hierarchy usually (not
  // always -- see shouldComponentUpdate()) will reconcile children, reconcile
  // them before their children by sorting the array.
  dirtyComponents.sort(mountOrderComparator);

  // Any updates enqueued while reconciling must be performed after this entire
  // batch. Otherwise, if dirtyComponents is [A, B] where A has children B and
  // C, B could update twice in a single batch if C's render enqueues an update
  // to B (since B would have already updated, we should skip it, and the only
  // way we can know to do so is by checking the batch counter).
  updateBatchNumber++;

  for (var i = 0; i < len; i++) {
    // If a component is unmounted before pending changes apply, it will still
    // be here, but we assume that it has cleared its _pendingCallbacks and
    // that performUpdateIfNecessary is a noop.
    var component = dirtyComponents[i];

    var markerName;
    if (ReactFeatureFlags.logTopLevelRenders) {
      var namedComponent = component;
      // Duck type TopLevelWrapper. This is probably always true.
      if (component._currentElement.type.isReactTopLevelWrapper) {
        namedComponent = component._renderedComponent;
      }
      markerName = 'React update: ' + namedComponent.getName();
      console.time(markerName);
    }

    ReactReconciler.performUpdateIfNecessary(
      component,
      transaction.reconcileTransaction,
      updateBatchNumber
    );

    if (markerName) {
      console.timeEnd(markerName);
    }
  }
}
/**
 * 在mount阶段，如果在componentWillMount、componentDidMount有setState发生，会在mount结束后执行该函数。（已证实）
 * 在updating阶段，（先猜测）如果在componentDidUpdate中有setState发生，在updating结束后也会执行。
 *
 * 其实不在mounting或者updating阶段，setState更新组件时，也是以事务形式执行，在事务close阶段会执行该函数。
 *
 * 总而言之，调用setState或者forceUpdate都会调用该函数。
 */
var flushBatchedUpdates = function() {
  // ReactUpdatesFlushTransaction's wrappers will clear the dirtyComponents
  // array and perform any updates enqueued by mount-ready handlers (i.e.,
  // componentDidUpdate) but we need to check here too in order to catch
  // updates enqueued by setState callbacks.
  while (dirtyComponents.length) {
    var transaction = ReactUpdatesFlushTransaction.getPooled();
    transaction.perform(runBatchedUpdates, null, transaction);
    ReactUpdatesFlushTransaction.release(transaction);
  }
};

/**
 * Mark a component as needing a rerender, adding an optional callback to a
 * list of functions which will be executed once the rerender occurs.
 */
function enqueueUpdate(component) {
  ensureInjected();

  // Various parts of our code (such as ReactCompositeComponent's
  // _renderValidatedComponent) assume that calls to render aren't nested;
  // verify that that's the case. (This is called by each top-level update
  // function, like setState, forceUpdate, etc.; creation and
  // destruction of top-level components is guarded in ReactMount.)
  // 理论上enqueueUpdate只有在调用setState或者forceUpdate的时候才会被调用。
  // 如果不是正处于mounting或者updating阶段，则立即处理update事务
  if (!batchingStrategy.isBatchingUpdates) {
    batchingStrategy.batchedUpdates(enqueueUpdate, component);
    return;
  }
  // 如果正在创建或更新组件,则暂且先不处理update,只是将组件放在dirtyComponents数组中
  dirtyComponents.push(component);
  //这里设计的很巧妙，如果在component._updateBatchNumber置空前，有组件进入dirtyComponent。下面判断为不成立。
  //为了避免不必要的渲染，componentWillReceiveProps中调用setState，不会引起重新渲染。
  if (component._updateBatchNumber == null) {
    component._updateBatchNumber = updateBatchNumber + 1;
  }
}

var ReactUpdatesInjection = {
  injectReconcileTransaction: function(ReconcileTransaction) {
    invariant(
      ReconcileTransaction,
      'ReactUpdates: must provide a reconcile transaction class'
    );
    ReactUpdates.ReactReconcileTransaction = ReconcileTransaction;
  },

  injectBatchingStrategy: function(_batchingStrategy) {
    invariant(
      _batchingStrategy,
      'ReactUpdates: must provide a batching strategy'
    );
    invariant(
      typeof _batchingStrategy.batchedUpdates === 'function',
      'ReactUpdates: must provide a batchedUpdates() function'
    );
    invariant(
      typeof _batchingStrategy.isBatchingUpdates === 'boolean',
      'ReactUpdates: must provide an isBatchingUpdates boolean attribute'
    );
    batchingStrategy = _batchingStrategy;
  },

  getBatchingStrategy: function() {
    return batchingStrategy;
  },
};

var ReactUpdates = {
  /**
   * React references `ReactReconcileTransaction` using this property in order
   * to allow dependency injection.
   *
   * @internal
   */
  ReactReconcileTransaction: null,

  batchedUpdates: batchedUpdates,
  enqueueUpdate: enqueueUpdate,
  flushBatchedUpdates: flushBatchedUpdates,
  injection: ReactUpdatesInjection,
};

module.exports = ReactUpdates;
