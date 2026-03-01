(async function () {
  try {
    const res = await api.get('/api/auth/verify');
    if (res.ok) {
      if (window.location.pathname !== '/desktop') {
        window.location.href = '/desktop';
      }
    } else {
      if (window.location.pathname !== '/login' && window.location.pathname !== '/') {
        window.location.href = '/login';
      }
    }
  } catch {
    if (window.location.pathname !== '/login' && window.location.pathname !== '/') {
      window.location.href = '/login';
    }
  }
})();
