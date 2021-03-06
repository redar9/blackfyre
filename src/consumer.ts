import { EventEmitter } from 'events';
import { setInterval, clearInterval } from 'timers';

import * as _ from 'lodash';
import * as amqp from 'amqplib';
import * as debug from 'debug';
import * as Bluebird from 'bluebird';

import {
  Task,
  TaskMeta,
  TaskState,
} from './common';

import { BackendType, Backend } from './backends/interface';
import { MongodbBackend, MongodbBackendOptions } from './backends/mongodb';
import { BrokerType, Broker } from './brokers/interface';
import { AMQPBroker, AMQPBrokerOptions } from './brokers/amqp';
import { registerEvent, checkVersion } from './helper';

Promise = Bluebird as any;

const log = debug('blackfyre:consumer');

export interface ProcessFunc {
  (data: any, task?: Task): Promise<any>;
}

export interface ConsumerOptions {
  /**
   *  Broker type, default: AMQP
   */
  brokerType?: BrokerType;

  /**
   *  Broker options
   */
  brokerOptions?: AMQPBrokerOptions;

  /**
   *  Backend type, default: MongoDB
   */
  backendType?: BackendType;

  /**
   *  Backend options
   */
  backendOptions?: MongodbBackendOptions;

  /**
   *  Apm wrap, such as newrelic
   */
  processWrap?: (taskName: string, func: ProcessFunc) => ProcessFunc;

  /**
   *  Rre process hook
   */
  preProcess?: (task: Task) => void;

  /**
   *  Post process hook
   */
  postProcess?: (task: Task, state: TaskState, errorOrResult: any) => void;

  /**
   * Global concurrency for task, will be overrided by task, default: 256
   */
  globalConcurrency?: number;
}

export class Consumer extends EventEmitter {
  private options: ConsumerOptions;

  private backend: Backend;
  private broker: Broker;

  public constructor(config: ConsumerOptions = {}) {
    super();

    const defaultOptions: ConsumerOptions = {
      processWrap: null,
      globalConcurrency: 256,
      backendType: BackendType.MongoDB,
      backendOptions: {},
      brokerType: BrokerType.AMQP,
      brokerOptions: {},
    };
    this.options = Object.assign({}, defaultOptions, config);

    log('Init backend %s', this.options.backendType);
    if (this.options.backendType === BackendType.MongoDB) {
      this.backend = new MongodbBackend(this.options.backendOptions);
      registerEvent(['error', 'close'], this.backend, this);
    }

    log('Init broker %s', this.options.brokerType);
    if (this.options.brokerType === BrokerType.AMQP) {
      this.broker = new AMQPBroker(this.options.brokerOptions);
      registerEvent(['error', 'ready', 'close'], this.broker, this);
    }

  }

  public async registerTask(taskMeta: TaskMeta, processFunc: ProcessFunc): Promise<void> {
    log('Register task %s', taskMeta.name);

    const that = this;

    taskMeta.concurrency = taskMeta.concurrency || this.options.globalConcurrency;

    if (this.options.processWrap) {
      processFunc = this.options.processWrap(taskMeta.name, processFunc);
    }

    async function processFuncWrap(body: any, task: Task) {
      await that.backend && that.backend.setTaskStateReceived(task);

      if (that.options.preProcess) {
        that.options.preProcess.bind(this);
        that.options.preProcess(task);
      }

      try {
        checkVersion(task.v);

        await that.backend && that.backend.setTaskStateStarted(task);
        const result = await processFunc(task.body, task);
        await that.backend && that.backend.setTaskStateSucceed(task, result);

        if (that.options.postProcess) {
          that.options.postProcess.bind(this);
          that.options.postProcess(task, TaskState.SUCCEED, result);
        }

      } catch (e) {
        // Mark error as noRetry result in task directly failed
        if (e.noRetry || task.retryCount === task.maxRetry) {
          e.state = TaskState.FAILED;
          await that.backend && that.backend.setTaskStateFailed(task, e);
        } else {
          e.state = TaskState.RETRYING;
          await that.backend && that.backend.setTaskStateRetrying(task, e);
        }

        if (that.options.postProcess) {
          that.options.postProcess.bind(this);
          that.options.postProcess(task, e.state, e);
        }

        throw e;
      }
    }

    await this.broker.registerTask(taskMeta, processFuncWrap);
  }

  public async close(): Promise<any> {
    return Promise.props({
      broker: this.broker.close(),
      backend: this.backend && this.backend.close(),
    });
  }

  public async checkHealth(): Promise<any> {
    return Promise.props({
      backend: this.backend && this.backend.checkHealth(),
      broker: this.broker.checkHealth(),
    });
  }
}
