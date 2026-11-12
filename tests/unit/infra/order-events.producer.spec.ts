import { Logger } from '@nestjs/common';
import { Producer } from 'kafkajs';
import {
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../../src/infra/kafka/order-events.producer';

const payload = {
  eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  aggregateId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  occurredAt: '2026-11-12T12:00:00.000Z',
  version: 1,
};

describe('OrderEventsProducer', () => {
  let send: jest.Mock;
  let connect: jest.Mock;
  let disconnect: jest.Mock;
  let producer: OrderEventsProducer;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send = jest.fn().mockResolvedValue([]);
    connect = jest.fn().mockResolvedValue(undefined);
    disconnect = jest.fn().mockResolvedValue(undefined);
    producer = new OrderEventsProducer({ send, connect, disconnect } as unknown as Producer);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('republish', () => {
    it('should send the stored payload unchanged, keyed by aggregateId', async () => {
      await producer.republish(ORDER_PLACED_TOPIC, payload);

      expect(send).toHaveBeenCalledWith({
        topic: ORDER_PLACED_TOPIC,
        messages: [{ key: payload.aggregateId, value: JSON.stringify(payload) }],
      });
    });

    it('should propagate send errors', async () => {
      send.mockRejectedValue(new Error('broker down'));

      await expect(producer.republish(ORDER_PLACED_TOPIC, payload)).rejects.toThrow('broker down');
    });
  });

  describe('lazy connection', () => {
    it('should not connect until the first publish', async () => {
      expect(connect).not.toHaveBeenCalled();

      await producer.republish(ORDER_PLACED_TOPIC, payload);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    });

    it('should share one connection attempt between concurrent publishes and reuse it', async () => {
      let finishConnect: () => void = () => undefined;
      connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishConnect = resolve;
          }),
      );

      const first = producer.republish(ORDER_PLACED_TOPIC, payload);
      const second = producer.republish(ORDER_PLACED_TOPIC, payload);
      finishConnect();
      await Promise.all([first, second]);
      await producer.republish(ORDER_PLACED_TOPIC, payload);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(3);
    });

    it('should propagate a failed connect without sending, then try to connect again on the next publish', async () => {
      connect.mockRejectedValueOnce(new Error('Connection error: ECONNREFUSED'));

      await expect(producer.republish(ORDER_PLACED_TOPIC, payload)).rejects.toThrow('ECONNREFUSED');
      expect(send).not.toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('Kafka is unreachable'),
      );

      await producer.republish(ORDER_PLACED_TOPIC, payload);

      expect(connect).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining('Kafka is available again'),
      );
    });
  });

  describe('shutdown', () => {
    it('should not disconnect (and not fail) when it never connected', async () => {
      await expect(producer.onApplicationShutdown()).resolves.toBeUndefined();

      expect(disconnect).not.toHaveBeenCalled();
    });

    it('should not disconnect when the only connect attempt failed', async () => {
      connect.mockRejectedValueOnce(new Error('down'));
      await producer.republish(ORDER_PLACED_TOPIC, payload).catch(() => undefined);

      await producer.onApplicationShutdown();

      expect(disconnect).not.toHaveBeenCalled();
    });

    it('should disconnect once connected', async () => {
      await producer.republish(ORDER_PLACED_TOPIC, payload);

      await producer.onApplicationShutdown();

      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('should wait for a connect still in flight, then disconnect', async () => {
      let finishConnect: () => void = () => undefined;
      connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishConnect = resolve;
          }),
      );
      const publishing = producer.republish(ORDER_PLACED_TOPIC, payload);

      const stopping = producer.onApplicationShutdown();
      finishConnect();
      await Promise.all([publishing, stopping]);

      expect(disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
