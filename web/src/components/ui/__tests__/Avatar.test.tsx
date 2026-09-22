// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { vi, type MockedFunction } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from '../Avatar';
import { resolveAvatar, type AvatarInput } from '@/lib/avatar';

vi.mock('@/lib/avatar', () => ({
  resolveAvatar: vi.fn(),
}));

const mockResolveAvatar = resolveAvatar as MockedFunction<typeof resolveAvatar>;

describe('Avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultInput: AvatarInput = {
    name: 'Test User',
    id: 'user-123',
    avatarUrl: null,
  };

  const defaultResolved = {
    kind: 'initials' as const,
    initials: 'TU',
    identity: {
      name: 'iris',
      color: '#8b5cf6',
      text: '#c4b5fd',
      soft: '#1e1b2e',
      gradient: 'linear-gradient(135deg, #1e1b2e 0%, #2d1b4e 100%)',
      ring: '#8b5cf6',
      border: '#8b5cf6',
      faint: 'rgba(139, 92, 246, 0.08)',
    },
    emoji: null,
    src: null,
  };

  it('renders initials when no avatar URL provided', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeInTheDocument();
    expect(avatar).toHaveTextContent('TU');
  });

  it('renders emoji when provided and no image', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'emoji',
      emoji: '🤖',
    });

    render(<Avatar {...defaultInput} emoji="🤖" />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeInTheDocument();
    expect(avatar).toHaveTextContent('🤖');
  });

  it('renders image when avatar URL provided and loads successfully', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'image',
      src: 'https://example.com/avatar.png',
    });

    render(<Avatar {...defaultInput} avatarUrl="https://example.com/avatar.png" />);

    const img = screen.getByRole('img', { name: 'Test User' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
  });

  it('falls back to initials when image fails to load', async () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'image',
      src: 'https://example.com/broken.png',
    });

    render(<Avatar {...defaultInput} avatarUrl="https://example.com/broken.png" />);

    const img = screen.getByRole('img', { name: 'Test User' });
    expect(img).toBeInTheDocument();

    fireEvent.error(img);

    await vi.waitFor(() => {
      const fallback = screen.getByRole('img', { name: 'Test User' });
      expect(fallback).toHaveTextContent('TU');
    });
  });

  it('renders with correct size classes', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    const sizes: Array<'xs' | 'sm' | 'md' | 'lg' | 'xl'> = ['xs', 'sm', 'md', 'lg', 'xl'];

    for (const size of sizes) {
      const { unmount } = render(<Avatar {...defaultInput} size={size} />);
      const avatar = screen.getByRole('img', { name: 'Test User' });
      const style = window.getComputedStyle(avatar as HTMLElement);
      expect(style.width).toBeTruthy();
      expect(style.height).toBeTruthy();
      unmount();
    }
  });

  it('renders with custom pixel size', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} size={56} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.width).toBeTruthy();
    expect(style.height).toBeTruthy();
  });

  it('applies ring when ring prop is true', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} ring />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.boxShadow).toBeTruthy();
  });

  it('does not apply ring when ring prop is false', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} ring={false} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeInTheDocument();
  });

  it('applies rounded-lg when rounded="lg"', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} rounded="lg" size={40} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.borderRadius).toBeTruthy();
  });

  it('applies full rounded when rounded="full"', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} rounded="full" size={40} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.borderRadius).toBe('9999px');
  });

  it('uses alt prop for accessible label when provided', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} alt="Custom label" />);

    const avatar = screen.getByRole('img', { name: 'Custom label' });
    expect(avatar).toBeInTheDocument();
  });

  it('applies custom className', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} className="custom-class" />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const wrapper = avatar.parentElement;
    expect(wrapper).toHaveClass('custom-class');
  });

  it('uses identity colors for background', () => {
    const customIdentity = {
      ...defaultResolved.identity,
      soft: '#ff0000',
      gradient: 'linear-gradient(135deg, #ff0000 0%, #cc0000 100%)',
      ring: '#ff0000',
    };
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      identity: customIdentity,
    });

    render(<Avatar {...defaultInput} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.background).toBeTruthy();
  });

  it('handles agent emoji fallback', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'emoji',
      emoji: '🤖',
    });

    render(<Avatar {...defaultInput} emoji="🤖" />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toHaveTextContent('🤖');
  });

  it('renders with correct font size for initials', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} size={32} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.fontSize).toBeTruthy();
  });

  it('renders with correct font size for emoji', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'emoji',
      emoji: '🤖',
    });

    render(<Avatar {...defaultInput} size={32} emoji="🤖" />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    const style = window.getComputedStyle(avatar as HTMLElement);
    expect(style.fontSize).toBeTruthy();
  });

  it('image has correct attributes for privacy', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'image',
      src: 'https://example.com/avatar.png',
    });

    render(<Avatar {...defaultInput} avatarUrl="https://example.com/avatar.png" />);

    const img = screen.getByRole('img', { name: 'Test User' });
    expect(img).toHaveAttribute('referrerPolicy', 'no-referrer');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
  });

  it('emoji role is img when label provided', () => {
    mockResolveAvatar.mockReturnValue({
      ...defaultResolved,
      kind: 'emoji',
      emoji: '🤖',
    });

    render(<Avatar {...defaultInput} emoji="🤖" />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeInTheDocument();
  });

  it('initials role is img when label provided', () => {
    mockResolveAvatar.mockReturnValue(defaultResolved);

    render(<Avatar {...defaultInput} />);

    const avatar = screen.getByRole('img', { name: 'Test User' });
    expect(avatar).toBeInTheDocument();
  });
});