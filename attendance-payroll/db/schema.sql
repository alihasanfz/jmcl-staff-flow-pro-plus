-- Corporate Attendance & Payroll — PostgreSQL schema (idempotent; applied on every start)

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shifts (
  id                      serial PRIMARY KEY,
  name                    text NOT NULL UNIQUE,
  start_time              time NOT NULL,
  end_time                time NOT NULL,
  break_minutes           int  NOT NULL DEFAULT 60 CHECK (break_minutes >= 0),
  grace_minutes           int  NOT NULL DEFAULT 10 CHECK (grace_minutes >= 0),
  early_out_grace_minutes int  NOT NULL DEFAULT 10 CHECK (early_out_grace_minutes >= 0),
  overtime_after_minutes  int  NOT NULL DEFAULT 30 CHECK (overtime_after_minutes >= 0),
  weekly_off              int[] NOT NULL DEFAULT '{5}',      -- 0=Sun … 6=Sat
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)                              -- overnight shifts are not supported in this version
);

CREATE TABLE IF NOT EXISTS users (
  id                   serial PRIMARY KEY,
  employee_code        text NOT NULL UNIQUE,
  device_pin           text NOT NULL UNIQUE,                 -- the PIN / user-id enrolled on the ZKTeco device
  name                 text NOT NULL,
  email                text NOT NULL,
  password_hash        text NOT NULL,
  role                 text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','hr','staff')),
  department           text NOT NULL DEFAULT 'General',
  designation          text NOT NULL DEFAULT '',
  shift_id             int  REFERENCES shifts(id),
  base_salary          numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  allowances           numeric(12,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  join_date            date NOT NULL DEFAULT CURRENT_DATE,
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS devices (
  id               serial PRIMARY KEY,
  name             text NOT NULL,
  serial_number    text NOT NULL UNIQUE,
  model            text NOT NULL DEFAULT 'ZKTeco uFace800',
  location         text NOT NULL DEFAULT '',
  protocol         text NOT NULL DEFAULT 'adms' CHECK (protocol IN ('adms','http-pull')),
  ip_address       text,
  port             int  CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  api_url          text,
  enforce_ip       boolean NOT NULL DEFAULT false,           -- accept ADMS pushes only from ip_address
  poll_interval_sec int NOT NULL DEFAULT 60 CHECK (poll_interval_sec >= 10),
  approved         boolean NOT NULL DEFAULT false,           -- unknown serials self-register as unapproved
  active           boolean NOT NULL DEFAULT true,
  online           boolean NOT NULL DEFAULT false,
  last_seen        timestamptz,
  last_punch_at    timestamptz,
  last_ip          text,
  attlog_stamp     text,
  last_poll_at     timestamptz,
  last_poll_error  text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_punch_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS default_shift_id int REFERENCES shifts(id);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_error text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS attlog_stamp text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_ip text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS port int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS api_url text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS enforce_ip boolean NOT NULL DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS poll_interval_sec int NOT NULL DEFAULT 60;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS online boolean NOT NULL DEFAULT true;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen timestamptz;

CREATE TABLE IF NOT EXISTS punch_logs (
  id          bigserial PRIMARY KEY,
  device_id   int REFERENCES devices(id) ON DELETE SET NULL,
  device_sn   text NOT NULL,
  pin         text NOT NULL,
  user_id     int REFERENCES users(id) ON DELETE SET NULL,
  punched_at  timestamptz NOT NULL,
  state       int,
  verify      int,
  workcode    text,
  source      text NOT NULL DEFAULT 'device' CHECK (source IN ('device','manual','simulator','poll')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_sn, pin, punched_at)
);
CREATE INDEX IF NOT EXISTS punch_logs_user_time_idx ON punch_logs (user_id, punched_at);
CREATE INDEX IF NOT EXISTS punch_logs_time_idx ON punch_logs (punched_at DESC);

CREATE TABLE IF NOT EXISTS holidays (
  date  date PRIMARY KEY,
  name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id                 bigserial PRIMARY KEY,
  user_id            int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date          date NOT NULL,
  shift_id           int  REFERENCES shifts(id),
  check_in           timestamptz,
  check_out          timestamptz,
  punch_count        int  NOT NULL DEFAULT 0,
  worked_minutes     int  NOT NULL DEFAULT 0,
  late_minutes       int  NOT NULL DEFAULT 0,
  early_out_minutes  int  NOT NULL DEFAULT 0,
  overtime_minutes   int  NOT NULL DEFAULT 0,
  status             text NOT NULL CHECK (status IN ('present','late','half_day','absent','leave','unpaid_leave','weekend','holiday')),
  missing_checkout   boolean NOT NULL DEFAULT false,
  off_day_work       boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance (work_date, status);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_sn text;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_device_sn text;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_device_sn text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_device_sn text;

CREATE TABLE IF NOT EXISTS leave_types (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  annual_quota numeric(5,1) CHECK (annual_quota IS NULL OR annual_quota >= 0),  -- NULL = no balance tracking (e.g. unpaid)
  paid         boolean NOT NULL DEFAULT true,
  active       boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS leave_balances (
  user_id        int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id  int NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year           int NOT NULL,
  allocated      numeric(5,1) NOT NULL DEFAULT 0,
  used           numeric(5,1) NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id             bigserial PRIMARY KEY,
  user_id        int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id  int NOT NULL REFERENCES leave_types(id),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  half_day       boolean NOT NULL DEFAULT false,
  days           numeric(5,1) NOT NULL CHECK (days > 0),
  reason         text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by    int REFERENCES users(id),
  reviewed_at    timestamptz,
  review_note    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS leave_requests_user_idx ON leave_requests (user_id, start_date);
CREATE INDEX IF NOT EXISTS leave_requests_status_idx ON leave_requests (status);

CREATE TABLE IF NOT EXISTS adjustments (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  kind        text NOT NULL CHECK (kind IN ('bonus','deduction')),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  note        text NOT NULL DEFAULT '',
  created_by  int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adjustments_month_idx ON adjustments (month, user_id);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id            serial PRIMARY KEY,
  month         text NOT NULL UNIQUE CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  partial       boolean NOT NULL DEFAULT false,
  generated_by  int REFERENCES users(id),
  generated_at  timestamptz NOT NULL DEFAULT now(),
  finalized_by  int REFERENCES users(id),
  finalized_at  timestamptz
);

CREATE TABLE IF NOT EXISTS payslips (
  id               bigserial PRIMARY KEY,
  run_id           int NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id          int NOT NULL REFERENCES users(id),
  base_pay         numeric(12,2) NOT NULL DEFAULT 0,
  allowances       numeric(12,2) NOT NULL DEFAULT 0,
  overtime_pay     numeric(12,2) NOT NULL DEFAULT 0,
  bonus            numeric(12,2) NOT NULL DEFAULT 0,
  gross            numeric(12,2) NOT NULL DEFAULT 0,
  absence_deduction numeric(12,2) NOT NULL DEFAULT 0,
  late_deduction   numeric(12,2) NOT NULL DEFAULT 0,
  pf_deduction     numeric(12,2) NOT NULL DEFAULT 0,
  tax_deduction    numeric(12,2) NOT NULL DEFAULT 0,
  other_deduction  numeric(12,2) NOT NULL DEFAULT 0,
  total_deductions numeric(12,2) NOT NULL DEFAULT 0,
  net_pay          numeric(12,2) NOT NULL DEFAULT 0,
  breakdown        jsonb NOT NULL DEFAULT '{}',
  UNIQUE (run_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  url         text NOT NULL DEFAULT '/',
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  user_id    int REFERENCES users(id) ON DELETE SET NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);

-- Device model: the terminal in use is the ZKTeco uFace800 (multi-biometric: face, fingerprint, card, password).
ALTER TABLE devices ALTER COLUMN model SET DEFAULT 'ZKTeco uFace800';
UPDATE devices SET model = 'ZKTeco uFace800' WHERE model = 'ZKTeco MB20-VL';

-- ============================================================================
-- JMCL STAFF FLOW PRO — ENTERPRISE HRM EXTENSIONS
-- ============================================================================

-- Branches
CREATE TABLE IF NOT EXISTS branches (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  code        text,
  address     text DEFAULT '',
  phone       text DEFAULT '',
  is_main     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Departments
CREATE TABLE IF NOT EXISTS departments (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  code        text,
  head_id     int,
  description text DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Designations
CREATE TABLE IF NOT EXISTS designations (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  department_id int REFERENCES departments(id) ON DELETE SET NULL,
  description   text DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Salary Structures (itemized breakdown according to Bangladesh Corporate Standard)
CREATE TABLE IF NOT EXISTS salary_structures (
  id                  serial PRIMARY KEY,
  user_id             int NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  basic_salary        numeric(12,2) NOT NULL DEFAULT 0 CHECK (basic_salary >= 0),
  house_rent          numeric(12,2) NOT NULL DEFAULT 0 CHECK (house_rent >= 0),
  medical_allowance   numeric(12,2) NOT NULL DEFAULT 0 CHECK (medical_allowance >= 0),
  conveyance          numeric(12,2) NOT NULL DEFAULT 0 CHECK (conveyance >= 0),
  other_allowances    numeric(12,2) NOT NULL DEFAULT 0 CHECK (other_allowances >= 0),
  gross_salary        numeric(12,2) NOT NULL DEFAULT 0 CHECK (gross_salary >= 0),
  tax_deduction       numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax_deduction >= 0),
  provident_fund      numeric(12,2) NOT NULL DEFAULT 0 CHECK (provident_fund >= 0),
  effective_from      date NOT NULL DEFAULT CURRENT_DATE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Overtime Records
CREATE TABLE IF NOT EXISTS overtime_records (
  id              bigserial PRIMARY KEY,
  user_id         int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date       date NOT NULL,
  minutes         int NOT NULL DEFAULT 0,
  hourly_rate     numeric(12,2) NOT NULL DEFAULT 0,
  multiplier      numeric(4,2) NOT NULL DEFAULT 1.0,
  amount          numeric(12,2) NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_by     int REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  note            text DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);
CREATE INDEX IF NOT EXISTS overtime_records_user_idx ON overtime_records (user_id, work_date);

-- Device Sync Logs
CREATE TABLE IF NOT EXISTS device_sync_logs (
  id             bigserial PRIMARY KEY,
  device_id      int REFERENCES devices(id) ON DELETE CASCADE,
  sync_type      text NOT NULL CHECK (sync_type IN ('adms_push', 'tcp_pull', 'manual_sync')),
  status         text NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
  records_synced int NOT NULL DEFAULT 0,
  error_message  text,
  duration_ms    int DEFAULT 0,
  synced_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_sync_logs_device_idx ON device_sync_logs (device_id, synced_at DESC);

-- Safe migrations for existing tables
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS address text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type text NOT NULL DEFAULT 'permanent';
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id int REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id int REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation_id int REFERENCES designations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id int REFERENCES branches(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dob date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blood_group text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS nid_number text DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bank_info jsonb NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions jsonb NOT NULL DEFAULT '{}';

-- Expand user roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'super_admin', 'company_admin', 'admin',
  'hr_manager', 'hr_executive', 'hr',
  'accounts_manager', 'dept_manager',
  'employee', 'staff'
));

-- Overnight / Cross-midnight shifts support
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_check;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_night_shift boolean NOT NULL DEFAULT false;

-- Detailed payslip fields
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS basic_salary numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS house_rent numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS medical_allowance numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS conveyance numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS advance_deduction numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS loan_deduction numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS festival_bonus numeric(12,2) NOT NULL DEFAULT 0;

-- Default branches, departments and designations seed (if empty)
INSERT INTO branches (name, is_main, address) VALUES ('Head Office', true, 'Dhaka, Bangladesh') ON CONFLICT (name) DO NOTHING;
INSERT INTO departments (name, code) VALUES
  ('Management', 'MGMT'),
  ('Human Resources', 'HR'),
  ('Accounts & Finance', 'ACC'),
  ('Information Technology', 'IT'),
  ('Operations', 'OPS'),
  ('Sales & Marketing', 'MKT')
ON CONFLICT (name) DO NOTHING;

INSERT INTO designations (name) VALUES
  ('Managing Director'),
  ('General Manager'),
  ('HR Manager'),
  ('HR Executive'),
  ('Accounts Manager'),
  ('Senior Accountant'),
  ('Software Engineer'),
  ('Senior Software Engineer'),
  ('QA Engineer'),
  ('Operations Executive'),
  ('Sales Executive')
ON CONFLICT (name) DO NOTHING;

-- ============================================================================
-- AUTOMATED BACKUP & RESTORE TABLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS backups (
  id               bigserial PRIMARY KEY,
  file_name        text NOT NULL,
  backup_type      text NOT NULL DEFAULT 'daily',
  scope            text NOT NULL DEFAULT 'full',
  file_size        bigint NOT NULL DEFAULT 0,
  checksum_sha256  text,
  encrypted        boolean NOT NULL DEFAULT true,
  storage_location text NOT NULL DEFAULT 'cloud',
  gdrive_file_id   text,
  gdrive_folder_id text,
  status           text NOT NULL DEFAULT 'completed',
  error_message    text,
  tables_count     int DEFAULT 0,
  records_count    int DEFAULT 0,
  metadata         jsonb DEFAULT '{}',
  file_data        bytea,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backups_created_at_idx ON backups (created_at DESC);

CREATE TABLE IF NOT EXISTS backup_logs (
  id               bigserial PRIMARY KEY,
  backup_id        bigint REFERENCES backups(id) ON DELETE CASCADE,
  action           text NOT NULL,
  status           text NOT NULL,
  message          text NOT NULL,
  details          jsonb DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS backup_logs_created_at_idx ON backup_logs (created_at DESC);


