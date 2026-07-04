create table if not exists public.projects (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.milestones (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.notes (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.attachments (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public."activityLogs" (
  id text primary key,
  project_id text null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.projects enable row level security;
alter table public.tasks enable row level security;
alter table public.milestones enable row level security;
alter table public.notes enable row level security;
alter table public.attachments enable row level security;
alter table public."activityLogs" enable row level security;

drop policy if exists "pmis anon read projects" on public.projects;
drop policy if exists "pmis anon write projects" on public.projects;
drop policy if exists "pmis anon read tasks" on public.tasks;
drop policy if exists "pmis anon write tasks" on public.tasks;
drop policy if exists "pmis anon read milestones" on public.milestones;
drop policy if exists "pmis anon write milestones" on public.milestones;
drop policy if exists "pmis anon read notes" on public.notes;
drop policy if exists "pmis anon write notes" on public.notes;
drop policy if exists "pmis anon read attachments" on public.attachments;
drop policy if exists "pmis anon write attachments" on public.attachments;
drop policy if exists "pmis anon read activityLogs" on public."activityLogs";
drop policy if exists "pmis anon write activityLogs" on public."activityLogs";

create policy "pmis anon read projects" on public.projects for select using (true);
create policy "pmis anon write projects" on public.projects for all using (true) with check (true);

create policy "pmis anon read tasks" on public.tasks for select using (true);
create policy "pmis anon write tasks" on public.tasks for all using (true) with check (true);

create policy "pmis anon read milestones" on public.milestones for select using (true);
create policy "pmis anon write milestones" on public.milestones for all using (true) with check (true);

create policy "pmis anon read notes" on public.notes for select using (true);
create policy "pmis anon write notes" on public.notes for all using (true) with check (true);

create policy "pmis anon read attachments" on public.attachments for select using (true);
create policy "pmis anon write attachments" on public.attachments for all using (true) with check (true);

create policy "pmis anon read activityLogs" on public."activityLogs" for select using (true);
create policy "pmis anon write activityLogs" on public."activityLogs" for all using (true) with check (true);
