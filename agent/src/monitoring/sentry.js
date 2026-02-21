import * as Sentry from '@sentry/node';

const SENTRY_DSN = process.env.SENTRY_DSN;

export function initSentry() {
  if (!SENTRY_DSN) {
    console.log('[Sentry] No SENTRY_DSN configured, error tracking disabled');
    return;
  }

  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.npm_package_version || '1.0.0',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Strip sensitive data
      if (event.request?.headers) {
        delete event.request.headers.authorization;
        delete event.request.headers.cookie;
      }
      return event;
    },
  });

  console.log('[Sentry] Error tracking initialized');
}

export function captureError(err, context = {}) {
  if (!SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (context.phone) scope.setTag('phone', context.phone);
    if (context.module) scope.setTag('module', context.module);
    if (context.action) scope.setTag('action', context.action);
    if (context.persona) scope.setTag('persona', context.persona);
    if (context.extra) scope.setExtras(context.extra);
    Sentry.captureException(err);
  });
}

export { Sentry };
