import { create } from 'zustand';

function parseJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp ? payload.exp * 1000 : null; // seconds → ms
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  username: string | null;
  role: string | null;
  isAuthenticated: boolean;
  tokenExpiresAt: number | null;
  login: (token: string, username: string, role: string) => void;
  logout: () => void;
  hydrate: () => void;
  isTokenExpired: () => boolean;
  getTimeUntilExpiry: () => number;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  username: null,
  role: null,
  isAuthenticated: false,
  tokenExpiresAt: null,

  login: (token, username, role) => {
    const tokenExpiresAt = parseJwtExp(token);
    localStorage.setItem('token', token);
    localStorage.setItem('username', username);
    localStorage.setItem('role', role);
    set({ token, username, role, isAuthenticated: true, tokenExpiresAt });
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
    set({ token: null, username: null, role: null, isAuthenticated: false, tokenExpiresAt: null });
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/auth')) {
      window.location.href = '/auth';
    }
  },

  hydrate: () => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('token');
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    if (token) {
      const tokenExpiresAt = parseJwtExp(token);
      // If already expired, logout immediately
      if (tokenExpiresAt && tokenExpiresAt <= Date.now()) {
        get().logout();
        return;
      }
      set({ token, username, role, isAuthenticated: true, tokenExpiresAt });
    }
  },

  isTokenExpired: () => {
    const { tokenExpiresAt } = get();
    if (!tokenExpiresAt) return false;
    return Date.now() >= tokenExpiresAt;
  },

  getTimeUntilExpiry: () => {
    const { tokenExpiresAt } = get();
    if (!tokenExpiresAt) return Infinity;
    return Math.max(0, tokenExpiresAt - Date.now());
  },
}));
