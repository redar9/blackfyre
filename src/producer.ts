import * as _ from 'lodash';
import * as amqp from 'amqplib';
import * as debug from 'debug';
import * as uuid from 'uuid';

import {
  Task,
  RetryStrategy,
} from './common';

import {
  getDelayQueue,
  getDelayQueueOptions,
} from './helper';

const log = debug('amqp-worker:producer');

export interface ProducerConfig {
  /**
   * Amqp exchange name, please be sure it is same as it in the consumer, default 'worker-exchange'
   */
  exchangeName?: string;

  /**
   * Test mode, useful for testing, default false
   */
  isTestMode?: boolean;

  /**
   * Amqp url, default 'amqp://localhost'
   */
  url?: string;

  /**
   *  Socket options for amqp connec
   */
  socketOptions?: amqp.Options.Connect;

  /**
   * Global max retry for task, will be override by task metadata, default: 0
   */
  globalMaxRetry?: number;

  /**
   * Global init delay for task, will be override by task metadata, default: 100
   */
  globalInitDelayMs?: number;

  /**
   * Global retry strategy for task, will be override by task metadata, default: FIBONACCI
   */
  globalretryStrategy?: RetryStrategy;
}

interface PublishFunc {
  (channel: amqp.ConfirmChannel): Promise<any>;
}

export class Producer {
  private connection: amqp.Connection;
  private channel: amqp.ConfirmChannel = null;
  private connecting: boolean = false;
  private waitQueue: any[] = [];
  private config: ProducerConfig;

  public createdTasks: Task[] = [];

  constructor(config: ProducerConfig = {}) {

    const defaultConfig: ProducerConfig = {
      exchangeName: 'worker-exchange',
      isTestMode: false,
      url: 'amqp://localhost',
      globalMaxRetry: 0,
      globalInitDelayMs: 100,
      globalretryStrategy: RetryStrategy.FIBONACCI,
    };
    this.config = Object.assign({}, defaultConfig, config);
  }

  private async createConnection(): Promise<amqp.Connection> {
    const url = this.config.url;
    this.connection = await amqp.connect(url, this.config.socketOptions);

    this.connection.on('error', (err) => {
      console.error(`Connection error ${err} stack: ${err.stack}`);
    });

    this.connection.on('close', () => {
      console.log('Connection close');
      this.connection = null;
    });

    return this.connection;
  }

  private async createChannel(): Promise<amqp.ConfirmChannel> {
    const conn = await this.createConnection();

    log('Created connection !!!');
    this.channel = await conn.createConfirmChannel();

    this.channel.on('error', (err) => {
      console.error(`Channel error ${err} stack: ${err.stack}`);
    });

    this.channel.on('close', () => {
      console.log('Channel close');
      this.channel = null;
    });

    log('Created channel !!!');
    await this.channel.assertExchange(this.config.exchangeName, 'direct');
    return this.channel;
  }

  private async drainQueue(): Promise<void> {
    log('Drain queue', this.waitQueue.length);
    while (this.waitQueue.length > 0) {
      const wait = this.waitQueue.pop();
      await wait(this.channel);
    }
  }

  private async getChannel(): Promise<amqp.ConfirmChannel> {
    log(`Wait queue length: ${this.waitQueue.length}`);
    if (!this.channel) {
      await this.createChannel();
    }
    await this.drainQueue();
    return this.channel;
  }

  private getPushlistFunc(task: Task): PublishFunc {
    const _this = this;
    return async function publish(ch) {
      const data = JSON.stringify(task);

      const exchangeName = _this.config.exchangeName;
      const routingKey = task.name;

      const publishOptions: amqp.Options.Publish = {
        persistent: true,
        priority: task.priority,
      };

      if (task.eta && task.eta > Date.now()) {
        const delayMs = task.eta - Date.now();
        const delayQueue = getDelayQueue(delayMs, exchangeName, routingKey);
        const queueDaclareOptions = getDelayQueueOptions(delayMs, exchangeName, routingKey);

        await ch.assertQueue(delayQueue, queueDaclareOptions);

        return ch.sendToQueue(delayQueue, new Buffer(data), publishOptions);
      }

      return new Promise((resolve, reject) => {
        return ch.publish(exchangeName, routingKey, new Buffer(data), publishOptions, (err, ok) => {
          if (err) return reject(err);
          return resolve(ok);
        });
      });
    };
  }

  public async createTask(task: Task): Promise<any> {
    task.id = uuid.v4();
    task.retryCount = 0;

    task.maxRetry = task.maxRetry || this.config.globalMaxRetry;
    task.initDelayMs = task.initDelayMs || this.config.globalInitDelayMs;
    task.retryStrategy = task.retryStrategy || this.config.globalretryStrategy;

    if (this.config.isTestMode) {
      this.createdTasks.push(task);
      return;
    }

    if (!this.connecting) {
      this.connecting = true;
      this.getChannel();
    }

    const publish: PublishFunc = this.getPushlistFunc(task);

    if (this.channel) return publish(this.channel);

    return new Promise((resolve, reject) => {
      this.waitQueue.push((channel) => {
        return publish(channel).then(resolve, reject);
      });
    });
  }
}
