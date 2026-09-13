-- supabase-schema.sql
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Column names are quoted camelCase so they match the JS objects used in
-- attendance-service.js / storage-service.js exactly — no field mapping needed.

create table if not exists students (
  id text primary key,
  name text not null,
  year text,
  "descriptors" jsonb,
  "createdAt" bigint,
  "updatedAt" bigint
);

create table if not exists attendance (
  id text primary key,
  "studentId" text not null,
  date date not null,
  time text,
  "weekNum" int,
  "academicYear" text,
  semester int,
  week int,
  "className" text,
  method text,
  timestamp bigint,
  "addedBy" text,
  "updatedAt" text
);
create index if not exists idx_attendance_date on attendance(date);
create index if not exists idx_attendance_student on attendance("studentId");

create table if not exists leaves (
  id text primary key,
  "studentId" text not null,
  date date not null,
  type text,
  reason text,
  status text,
  timestamp bigint,
  "addedBy" text,
  "academicYear" text,
  semester int,
  week int,
  "className" text
);
create index if not exists idx_leaves_student_date on leaves("studentId", date);

create table if not exists classes (
  "classId" text primary key,
  code text unique not null,
  name text not null,
  "createdAt" bigint,
  "createdBy" text,
  "updatedAt" bigint,
  "updatedBy" text
);

create table if not exists class_students (
  id bigserial primary key,
  "classId" text not null,
  "studentId" text not null,
  "studentName" text,
  "assignedAt" bigint,
  "assignedBy" text,
  unique ("classId", "studentId")
);

create table if not exists scan_log (
  "scanId" text primary key,
  "studentId" text,
  "studentName" text,
  class text,
  "scanTime" bigint,
  date date,
  result text,
  "attendanceStatus" text,
  "evidenceRef" text,
  confidence numeric,
  admin text,
  error text
);
create index if not exists idx_scan_log_date on scan_log(date);

create table if not exists audit (
  id bigserial primary key,
  action text,
  "recordId" text,
  "studentId" text,
  date date,
  "previousStatus" text,
  "newStatus" text,
  reason text,
  method text,
  "changedBy" text,
  timestamp timestamptz,
  "academicYear" text,
  semester int,
  week int,
  "className" text
);

create table if not exists evidence (
  "evidenceId" text primary key,
  "storageRef" text not null,
  "captureAt" bigint,
  "fileType" text,
  "fileSize" bigint,
  status text,
  "createdAt" bigint,
  "attendanceId" text
);

-- Storage bucket for evidence photos (private — accessed only via the
-- service-role key from storage-service.js, never exposed to the browser).
insert into storage.buckets (id, name, public)
values ('evidence-photos', 'evidence-photos', false)
on conflict (id) do nothing;

-- These tables are only ever touched by the backend services using the
-- SERVICE ROLE key (which bypasses RLS), so Row Level Security stays
-- disabled here by default — the services are the only "client" that
-- talks to Postgres directly. If you later add anon/browser access to
-- Supabase for these tables, enable RLS and write policies first.
