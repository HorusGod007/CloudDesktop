(function () {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('error-message');
  const btn = document.getElementById('login-btn');
  const credentialsGroup = document.getElementById('credentials-group');
  const otpGroup = document.getElementById('otp-group');
  const otpInput = document.getElementById('otp');
  const otpBackBtn = document.getElementById('otp-back');

  let storedUsername = '';
  let storedPassword = '';
  let otpMode = false;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      if (otpMode) {
        const otp = otpInput.value.trim();
        if (!otp) {
          showError('Enter your 6-digit code');
          return;
        }
        const res = await api.post('/api/auth/login/otp', {
          username: storedUsername,
          password: storedPassword,
          otp,
        });
        if (res.ok) {
          window.location.href = '/desktop';
        } else {
          const data = await res.json().catch(() => ({}));
          showError(data.error || 'Invalid OTP code');
        }
      } else {
        storedUsername = document.getElementById('username').value.trim();
        storedPassword = document.getElementById('password').value;

        const res = await api.post('/api/auth/login', {
          username: storedUsername,
          password: storedPassword,
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok && data.otpRequired) {
          enterOtpMode();
          return;
        }

        if (res.ok) {
          window.location.href = '/desktop';
        } else {
          showError(data.error || 'Invalid credentials');
        }
      }
    } catch (err) {
      showError('Connection failed. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = otpMode ? 'Verify' : 'Sign In';
    }
  });

  function enterOtpMode() {
    otpMode = true;
    credentialsGroup.hidden = true;
    otpGroup.hidden = false;
    otpInput.value = '';
    otpInput.focus();
    btn.textContent = 'Verify';
    btn.disabled = false;
    errorEl.hidden = true;
  }

  function exitOtpMode() {
    otpMode = false;
    credentialsGroup.hidden = false;
    otpGroup.hidden = true;
    btn.textContent = 'Sign In';
    btn.disabled = false;
    errorEl.hidden = true;
    storedPassword = '';
  }

  otpBackBtn.addEventListener('click', exitOtpMode);

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  // If already authenticated, redirect to desktop
  api.get('/api/auth/verify').then((res) => {
    if (res.ok) window.location.href = '/desktop';
  }).catch(() => {});
})();
