type PageLocation = Pick<Location, 'protocol' | 'host'>;

export function conversationWebSocketUrl(page: PageLocation, configuredOrigin = '') {
  if (configuredOrigin) {
    const backend = new URL(configuredOrigin);
    if (backend.protocol !== 'wss:' || backend.username || backend.password
      || backend.pathname !== '/' || backend.search || backend.hash) {
      throw new Error('Invalid packaged backend origin');
    }
    return `${backend.origin}/ws/conversation`;
  }

  if (!['http:', 'https:'].includes(page.protocol) || !page.host) {
    throw new Error('No backend configured for this build');
  }
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ws/conversation`;
}
