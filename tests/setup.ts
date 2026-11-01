import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest globals are off, so Testing Library cannot register its automatic
// cleanup: unmount every rendered tree after each test explicitly.
afterEach(() => {
  cleanup();
});
