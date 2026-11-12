import { Producer } from 'kafkajs';
import {
  ORDER_PLACED_TOPIC,
  OrderEventsProducer,
} from '../../../src/infra/kafka/order-events.producer';

describe('OrderEventsProducer.republish', () => {
  const payload = {
    eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    aggregateId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    occurredAt: '2026-11-12T12:00:00.000Z',
    version: 1,
  };
  let send: jest.Mock;
  let producer: OrderEventsProducer;

  beforeEach(() => {
    send = jest.fn().mockResolvedValue([]);
    producer = new OrderEventsProducer({ send } as unknown as Producer);
  });

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
