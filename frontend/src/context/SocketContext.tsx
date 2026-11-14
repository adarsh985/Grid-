import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { Alert, Reading } from '../types';
import { useAuth } from './AuthContext';

export const WS_BASE_URL = (import.meta.env.VITE_WS_URL ?? '').replace(/\/$/, '');

type ReadingListener = (reading: Reading) => void;
type AlertListener = (alert: Alert) => void;

interface SocketContextValue {
  connected: boolean;
  onReading: (cb: ReadingListener) => () => void;
  onAlert: (cb: AlertListener) => () => void;
  onAlertUpdate: (cb: AlertListener) => () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuth();
  const [connected, setConnected] = useState(false);

  const readingListeners = useRef(new Set<ReadingListener>());
  const alertListeners = useRef(new Set<AlertListener>());
  const alertUpdateListeners = useRef(new Set<AlertListener>());

  useEffect(() => {
    if (!token) {
      setConnected(false);
      return;
    }

    const opts = {
      auth: { token },
      transports: ['websocket', 'polling'],
      autoConnect: true,
    };
    const socket: Socket = WS_BASE_URL ? io(WS_BASE_URL, opts) : io(opts);

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('reading', (payload: Reading) => {
      readingListeners.current.forEach((cb) => cb(payload));
    });
    socket.on('alert', (payload: Alert) => {
      alertListeners.current.forEach((cb) => cb(payload));
    });
    socket.on('alert:update', (payload: Alert) => {
      alertUpdateListeners.current.forEach((cb) => cb(payload));
    });

    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [token]);

  const onReading = useCallback((cb: ReadingListener) => {
    readingListeners.current.add(cb);
    return () => {
      readingListeners.current.delete(cb);
    };
  }, []);

  const onAlert = useCallback((cb: AlertListener) => {
    alertListeners.current.add(cb);
    return () => {
      alertListeners.current.delete(cb);
    };
  }, []);

  const onAlertUpdate = useCallback((cb: AlertListener) => {
    alertUpdateListeners.current.add(cb);
    return () => {
      alertUpdateListeners.current.delete(cb);
    };
  }, []);

  return (
    <SocketContext.Provider value={{ connected, onReading, onAlert, onAlertUpdate }}>
      {children}
    </SocketContext.Provider>
  );
};

export function useSocket(): SocketContextValue {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used inside SocketProvider');
  return ctx;
}
