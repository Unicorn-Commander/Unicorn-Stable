import '@testing-library/jest-dom';
import { vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const mockComputedStyle = {
  width: '32px',
  height: '32px',
  borderRadius: '9999px',
  boxShadow: '0 0 0 2px #8b5cf6',
  background: 'linear-gradient(135deg, #1e1b2e 0%, #2d1b4e 100%)',
  fontSize: '13px',
  getPropertyValue: vi.fn((prop: string) => {
    return mockComputedStyle[prop as keyof typeof mockComputedStyle] || '';
  }),
};

let currentSize = 32;
Object.defineProperty(window, 'getComputedStyle', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    ...mockComputedStyle,
    get width() { return `${currentSize}px`; },
    get height() { return `${currentSize}px`; },
  })),
});

HTMLCanvasElement.prototype.getContext = vi.fn(() => null);

Object.defineProperty(HTMLImageElement.prototype, 'onload', {
  writable: true,
  value: vi.fn(),
});

Object.defineProperty(HTMLImageElement.prototype, 'onerror', {
  writable: true,
  value: vi.fn(),
});