const fs = require('fs');

async function main() {
  const base = 'https://jmcl-staff-flow-pro-plus.onrender.com';
  console.log('Logging in to Render...');
  const loginRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ email: 'alihasanfzl@gmail.com', password: 'Sh@170885' })
  });
  const cookie = loginRes.headers.get('set-cookie');
  console.log('Login result:', loginRes.status, 'Cookie:', !!cookie);

  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(base + '/api/attendance/restore-shifted-punches', {
        method: 'POST',
        headers: { 'Cookie': cookie, 'X-Requested-With': 'fetch' }
      });
      console.log(`[Attempt ${i + 1}] /restore-shifted-punches -> status: ${res.status}`);
      if (res.status === 200) {
        const data = await res.json();
        console.log('Restore response:', JSON.stringify(data, null, 2));

        // Now inspect the attendance records
        const attRes = await fetch(base + '/api/attendance?from=2026-11-11&to=2026-11-11', {
          headers: { 'Cookie': cookie, 'X-Requested-With': 'fetch' }
        });
        const rows = await attRes.json();
        console.log(`Retrieved ${rows.length} attendance rows for 2026-11-11`);
        const searchList = ['Biplob', 'Nahid', 'Rifat', 'Mehedi', 'Tanjil', 'Sohag'];
        const filtered = rows.filter(r => searchList.some(s => (r.name || r.employee_name || '').toLowerCase().includes(s.toLowerCase())));
        console.log('Sample matched records:');
        console.table(filtered.map(r => ({
          Name: r.name || r.employee_name,
          Code: r.employee_code || r.code,
          InTime: r.check_in_local || r.check_in,
          OutTime: r.check_out_local || r.check_out,
          Punches: r.punch_count,
          Status: r.status
        })));
        return;
      }
    } catch (err) {
      console.log(`Attempt ${i + 1} network error: ${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 8000));
  }
}

main().catch(console.error);
