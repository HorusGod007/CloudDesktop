const api = {
  async request(method, url, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: {},
    };

    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    // Auto-redirect to login on 401 (except for verify/login endpoints)
    if (res.status === 401 &&
        !url.includes('/api/auth/login') &&
        !url.includes('/api/auth/verify')) {
      window.location.href = '/login';
    }

    return res;
  },

  get(url) {
    return this.request('GET', url);
  },

  post(url, body) {
    return this.request('POST', url, body);
  },
};
