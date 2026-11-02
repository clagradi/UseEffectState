// @vitest-environment node
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { useEffectState, useEffectTask, useEvent, useLayoutEffectTask } from '../src';

describe('server rendering', () => {
  it('renders every hook without running tasks or logging anything', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const task = vi.fn();

    function Page() {
      useEffectTask(task, []);
      useLayoutEffectTask(task, []);
      useEffectTask(task, [], { layout: true });
      const user = useEffectState(async () => 'data', []);
      const disabled = useEffectState(async () => 'data', [], { enabled: false });
      const seeded = useEffectState(async () => ['fresh'], [], { placeholderData: ['initial'] });
      const onClick = useEvent(() => undefined);

      return createElement(
        'button',
        { onClick },
        `${user.status}/${String(user.isRunning)} ${disabled.status} ${seeded.status}:${seeded.data.join()}`
      );
    }

    const html = renderToString(createElement(Page));

    expect(html).toBe('<button>pending/true idle pending:initial</button>');
    expect(task).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
