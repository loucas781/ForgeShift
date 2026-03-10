// ── ForgeShift API Client ──────────────────────────────────────────────────

class ApiClient {
  async request(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch('/api' + path, opts);
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  get(path)          { return this.request('GET', path); }
  post(path, body)   { return this.request('POST', path, body); }
  put(path, body)    { return this.request('PUT', path, body); }
  delete(path)       { return this.request('DELETE', path); }

  // Auth
  login(identifier, password)     { return this.post('/auth/login', { identifier, password }); }
  logout()                        { return this.post('/auth/logout'); }
  register(data)                  { return this.post('/auth/register', data); }
  getMe()                         { return this.get('/auth/me'); }
  signupEnabled()                 { return this.get('/auth/signup-enabled'); }

  // Shifts
  getShifts(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get('/shifts' + (q ? '?' + q : ''));
  }
  createShift(data)               { return this.post('/shifts', data); }
  updateShift(id, data)           { return this.put(`/shifts/${id}`, data); }
  deleteShift(id)                 { return this.delete(`/shifts/${id}`); }

  // Templates
  getTemplates()                  { return this.get('/templates'); }
  createTemplate(data)            { return this.post('/templates', data); }
  updateTemplate(id, data)        { return this.put(`/templates/${id}`, data); }
  deleteTemplate(id)              { return this.delete(`/templates/${id}`); }
  applyTemplate(id, data)         { return this.post(`/templates/${id}/apply`, data); }

  // Locations
  getLocations()                  { return this.get('/locations'); }
  createLocation(data)            { return this.post('/locations', data); }
  updateLocation(id, data)        { return this.put(`/locations/${id}`, data); }
  deleteLocation(id)              { return this.delete(`/locations/${id}`); }

  // Users (admin)
  getUsers()                      { return this.get('/users'); }
  createUser(data)                { return this.post('/users', data); }
  updateUser(id, data)            { return this.put(`/users/${id}`, data); }
  deleteUser(id)                  { return this.delete(`/users/${id}`); }
  resetPassword(id, newPassword)  { return this.post(`/users/${id}/reset-password`, { newPassword }); }
  updateMe(data)                  { return this.put('/users/me', data); }
  changeMyPassword(d)             { return this.put('/users/me/password', d); }

  // iCal
  getIcalToken()             { return this.get('/ical/token'); }
  generateIcalToken()        { return this.post('/ical/token/generate'); }
  revokeIcalToken()          { return this.delete('/ical/token'); }

  // Settings
  getSettings()                   { return this.get('/settings'); }
  setSetting(key, value)          { return this.put(`/settings/${key}`, { value }); }
}

window.api = new ApiClient();
