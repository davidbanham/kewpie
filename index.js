const amqp = require('amqplib');
const uuid = require('uuid');

function kewpie(passedOpts = {}) {
  const defaultOpts = {
    deadLetterExchange: 'deadletters',
    deadLetterQueue: 'deadletters',
    exchange: 'kewpie',
    maxPriority: 10,
    defaultExpiration: 1000 * 60 * 60, // 1 hour
    maxConnectionAttempts: 10,
    delayMS: 500
  };

  const opts = Object.assign({}, passedOpts, defaultOpts);

  const {
    delayMS,
    maxConnectionAttempts,
    defaultExpiration,
    maxPriority,
    deadLetterExchange,
    deadLetterQueue,
    exchange
  } = opts;

  const queueOpts = {
    maxPriority,
    durable: true,
    deadLetterExchange
  };

  let channel, connection;
  let connectionAttempts = 0;

  function connect(rabbitUrl, queues) {
    return amqp.connect(rabbitUrl).then(conn => {
      connection = conn;
      conn.createConfirmChannel().then(ch => {

        return ch.assertExchange(exchange, 'topic', {durable: true})
        .then(queues.map(queue => {
          return ch.assertQueue(queue, queueOpts)
          .then(ch.bindQueue(queue, exchange, queue));
        }))
        .then(() => {
          ch.assertExchange(deadLetterExchange, 'topic', {durable: true})
          .then(() => {
            return ch.assertQueue(deadLetterQueue, {durable: true});
          }).then(() => {
            return ch.bindQueue(deadLetterQueue, deadLetterExchange, '#');
          }).then(() => {
            channel = ch;
          }).catch(e => {
            throw e;
          });
        });
      });
    }).catch(e => {
      connectionAttempts++;
      if (connectionAttempts > maxConnectionAttempts) {
        throw e;
      } else {
        return delay()
        .then(() => connect(rabbitUrl, queues, opts));
      }
    });
  };

  function publish(queue, task, opts = {}) {
    if (!queue) return Promise.reject('Queue name is blank');
    if (!task) return Promise.reject('Task body is blank');

    if (!channel) return delay()
    .then(() => {
      return publish(queue, task, opts);
    });

    const innerOpts = {
      priority: opts.priority || 0,
      persistent: true,
      expiration: opts.expiration || defaultExpiration
    };

    if (opts.expiration === null) delete innerOpts.expiration;

    const buf = new Buffer(JSON.stringify(task));

    return new Promise((resolve, reject) => {
      channel.publish(exchange, queue, buf, innerOpts, function(err) {
        if (err) return reject(err);
        return resolve(task);
      });
    });
  };

  function unsubscribe(tag) {
    return channel.cancel(tag);
  };

  function subscribe(queue, handler) {
    if (!channel) return delay()
    .then(() => {
      return subscribe(queue, handler);
    });

    const consumerTag = uuid.v4();

    return new Promise((resolve, reject) => {

      channel.assertQueue(queue, queueOpts)
      .then(() => {
        channel.prefetch(process.env.MAX_CONCURRENT_JOBS || 1);

        channel.consume(queue, function(msg) {
          try {
            handler(JSON.parse(msg.content.toString()))
            .then(() => {
              channel.ack(msg);
            })
            .catch(({requeue = false}) => {
              channel.nack(msg, false, requeue);
            });
          } catch (e) {
            // The only time this should be reached is when JSON.parse fails, so never requeue this kind of failure
            channel.nack(msg, false, false);
          }
        }, {consumerTag});

        return resolve({consumerTag});
      });
    });
  };

  function close() {
    return connection.close();
  };

  function delay() {
    return new Promise(resolve => {
      setTimeout(resolve, delayMS);
    });
  };

  return {
    publish,
    subscribe,
    unsubscribe,
    connect,
    close
  };
};

module.exports = kewpie;
