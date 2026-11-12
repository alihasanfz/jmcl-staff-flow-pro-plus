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

  // Poll for deployment by checking if /api/attendance/restore-shifted-punches is running new code
  for (let i = 0; i < 25; i++) {
    try {
      const res = await fetch(base + '/api/attendance/restore-shifted-punches', {
        method: 'POST',
        headers: { 'Cookie': cookie, 'X-Requested-With': 'fetch' }
      });
      console.log(`[Attempt ${i + 1}] /restore-shifted-punches status: ${res.status}`);
      if (res.status === 200) {
        const data = await res.json();
        console.log('Restore response:', JSON.stringify(data, null, 2));

        // Query attendance for 2026-11-11
        const attRes = await fetch(base + '/api/attendance?from=2026-11-11&to=2026-11-11', {
          headers: { 'Cookie': cookie, 'X-Requested-With': 'fetch' }
        });
        const attData = await attRes.json();
        const rows = attData.rows || attData;
        console.log(`\n=== ATTENDANCE FOR 2026-11-11 (Total rows: ${rows.length}) ===`);

        const withOut = rows.filter(r => r.check_out_local || r.check_out);
        console.log(`Employees with check_out: ${withOut.length}`);
        console.table(withOut.map(r => ({
          name: r.employee_name || r.name,
          in: r.check_in_local || r.check_in,
          out: r.check_out_local || r.check_out,
          status: r.status,
          workedHrs: (r.worked_minutes / 60).toFixed(1) + ' hrs'
        })));

        // Check the 9 employees who punched yesterday evening
        const eveNames = ['Sohag', 'Mumit', 'Firoj', 'Nirob', 'Naushadul', 'Sabbir', 'Sazid', 'Steve', 'Zobayed'];
        const eveRows = rows.filter(r => eveNames.some(n => (r.employee_name || r.name || '').includes(n)));
        console.log('\n--- Evening Punchers on 2026-11-11 ---');
        console.table(eveRows.map(r => ({
          name: r.employee_name || r.name,
          in: r.check_in_local || r.check_in,
          out: r.check_out_local || r.check_out,
          status: r.status,
          ot: r.overtime_minutes + ' min'
        })));

        // Check employees who only had morning punches (e.g. Biplob, Nahid)
        const mornNames = ['Biplob', 'Nahid Parvez', 'Mehedi Hasan'];
        const mornRows = rows.filter(r => mornNames.some(n => (r.employee_name || r.name || '').includes(n)));
        console.log('\n--- Sample Morning Punchers on 2026-11-11 ---');
        console.table(mornRows.map(r => ({
          name: r.employee_name || r.name,
          in: r.check_in_local || r.check_in,
          out: r.check_out_local || r.check_out,
          missingCheckout: r.missing_checkout,
          status: r.status
        })));

        return;
      }
    } catch (e) {
      console.log(`Attempt ${i + 1} err:`, e.message);
    }
    await new Promise(r => setTimeout(r, 6000));
  }
}

main().catch(console.error);
