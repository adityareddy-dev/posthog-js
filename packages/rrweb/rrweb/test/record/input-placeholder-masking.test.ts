/**
 * @vitest-environment jsdom
 */
import { visitSnapshot } from '@posthog/rrweb-snapshot';
import { EventType, IncrementalSource, NodeType } from '@posthog/rrweb-types';
import type { eventWithTime } from '@posthog/rrweb-types';
import type { recordOptions } from '../../src/types';
import record from '../../src/record';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const fields = ['text', 'email', 'textarea', 'exempt'];
const cases: {
  name: string;
  options: recordOptions<eventWithTime>;
  expected: (id: string, value: string) => string;
}[] = [
  {
    name: 'all inputs',
    options: { maskAllInputs: true },
    expected: (_id, value) => '*'.repeat(value.length),
  },
  {
    name: 'input type',
    options: { maskInputOptions: { email: true } },
    expected: (id, value) =>
      id === 'email' ? '*'.repeat(value.length) : value,
  },
  {
    name: 'textarea',
    options: { maskInputOptions: { textarea: true } },
    expected: (id, value) =>
      id === 'textarea' ? '*'.repeat(value.length) : value,
  },
  {
    name: 'custom callback and element exemption',
    options: {
      maskAllInputs: true,
      maskInputFn: (value, element) =>
        element.id === 'exempt' ? value : '[masked]',
    },
    expected: (id, value) => (id === 'exempt' ? value : '[masked]'),
  },
  {
    name: 'masking disabled',
    options: { maskAllInputs: false },
    expected: (_id, value) => value,
  },
];

describe('input placeholder masking', () => {
  let stop: (() => void) | undefined;
  let events: eventWithTime[];

  beforeEach(() => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36',
    );
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    document.body.innerHTML =
      '<input id="text" placeholder="initial"><input id="email" type="email" placeholder="initial"><textarea id="textarea" placeholder="initial"></textarea><input id="exempt" placeholder="initial">';
    events = [];
  });

  afterEach(() => {
    stop?.();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const start = (options: recordOptions<eventWithTime>) => {
    stop = record({ emit: (event) => events.push(event), ...options });
  };

  const attributeMutations = () =>
    events.flatMap((event) =>
      event.type === EventType.IncrementalSnapshot &&
      event.data.source === IncrementalSource.Mutation
        ? event.data.attributes
        : [],
    );

  it.each(cases)(
    'applies $name to initial placeholders',
    ({ options, expected }) => {
      start(options);
      const snapshot = events.find(
        (event) => event.type === EventType.FullSnapshot,
      )!;
      if (snapshot.type !== EventType.FullSnapshot)
        throw new Error('missing snapshot');
      const placeholders: Record<string, unknown> = {};
      visitSnapshot(snapshot.data.node, (node) => {
        if (
          node.type === NodeType.Element &&
          fields.includes(String(node.attributes.id))
        ) {
          placeholders[String(node.attributes.id)] =
            node.attributes.placeholder;
        }
      });
      for (const id of fields)
        expect(placeholders[id]).toBe(expected(id, 'initial'));
    },
  );

  it.each(cases)(
    'applies $name to placeholder updates',
    async ({ options, expected }) => {
      start(options);
      events = [];
      for (const id of fields)
        document
          .getElementById(id)!
          .setAttribute('placeholder', 'updated private');
      await settle();
      for (const id of fields) {
        const mutation = attributeMutations().find(
          (item) =>
            item.id === record.mirror.getId(document.getElementById(id)!),
        );
        expect(mutation?.attributes.placeholder).toBe(
          expected(id, 'updated private'),
        );
      }
    },
  );

  it.each(['text', 'textarea'])(
    'preserves removal of a masked %s placeholder',
    async (id) => {
      start({ maskAllInputs: true });
      const field = document.getElementById(id)!;
      field.removeAttribute('placeholder');
      await settle();
      expect(attributeMutations()).toContainEqual({
        id: record.mirror.getId(field),
        attributes: { placeholder: null },
      });
    },
  );

  it('preserves placeholder attributes on non-form elements', async () => {
    const div = document.createElement('div');
    div.setAttribute('placeholder', 'initial');
    document.body.appendChild(div);
    start({ maskAllInputs: true });
    div.setAttribute('placeholder', 'updated');
    await settle();
    expect(attributeMutations()).toContainEqual({
      id: record.mirror.getId(div),
      attributes: { placeholder: 'updated' },
    });
  });
});
