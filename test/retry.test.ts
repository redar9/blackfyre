import test from 'ava';

import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import { Producer, Consumer, Task, RetryStrategy, TaskMeta, TaskState } from '../src/index';
import { waitUtilDone } from './utils';

Promise = Bluebird as any;

async function testRetry(t, retryStrategy: RetryStrategy) {
  const taskName = `test-retry-${retryStrategy}`;

  const maxRetry = 3;
  t.plan(maxRetry + 1);
  const { promise, doneOne } = waitUtilDone(maxRetry + 1);

  const consumer = new Consumer();

  consumer.registerTask(<TaskMeta>{
    name: taskName,
    concurrency: 20,
  }, async (data) => {
    t.true(true);
    doneOne();
    throw new Error('test');
  });

  consumer.on('ready', async () => {
    await (new Producer())
      .createTask(<Task>{
        name: taskName,
        body: { test: 'test' },
        initDelayMs: 100,
        maxRetry,
        retryStrategy,
      });
  });

  await promise;
}

test('#retry task fib', async t => {
  await testRetry(t, RetryStrategy.FIBONACCI);
});

test('#retry task exp', async t => {
  await testRetry(t, RetryStrategy.EXPONENTIAL);
});

test('#retry task lne', async t => {
  await testRetry(t, RetryStrategy.LINEAR);
});

class CustomError extends Error {
  noRetry: boolean = true;
}

test('#retry task abort', async t => {
  const taskName = `test-retry-abort`;

  const maxRetry = 5;
  t.plan(3);
  const { promise, doneOne } = waitUtilDone(1);

  const consumer = new Consumer({
    postProcess(task, state, errorOrResult) {
      t.is(state, TaskState.FAILED);
      t.is(errorOrResult.message, 'test');
    },
  });

  consumer.registerTask(<TaskMeta>{
    name: taskName,
    concurrency: 20,
  }, async (data) => {
    t.true(true);
    doneOne();
    throw new CustomError('test');
  });

  consumer.on('ready', async () => {
    await (new Producer())
      .createTask(<Task>{
        name: taskName,
        body: { test: 'test' },
        initDelayMs: 50,
        maxRetry,
      });
  });

  await promise;
});
