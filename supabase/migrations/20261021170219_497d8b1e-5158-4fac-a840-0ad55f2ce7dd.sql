create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  goals text,
  experience_level text,
  explanation_style text,
  main_objective text,
  weekly_target_minutes int not null default 300,
  study_days text[] not null default '{}',
  study_hours text,
  target_date date,
  timezone text not null default 'UTC',
  onboarding_step int not null default 0,
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "own profile read" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update to authenticated using (auth.uid() = id);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null,
  notes text,
  due_date date,
  priority text not null default 'medium',
  tag text,
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.tasks to authenticated;
grant all on public.tasks to service_role;
alter table public.tasks enable row level security;
create policy "own tasks" on public.tasks for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null default 'study',
  completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.events to authenticated;
grant all on public.events to service_role;
alter table public.events enable row level security;
create policy "own events" on public.events for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table public.focus_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  task_id uuid references public.tasks(id) on delete set null,
  label text,
  planned_minutes int not null,
  actual_seconds int not null,
  status text not null default 'completed',
  started_at timestamptz not null,
  ended_at timestamptz not null,
  created_at timestamptz not null default now()
);
grant select, insert, delete on public.focus_sessions to authenticated;
grant all on public.focus_sessions to service_role;
alter table public.focus_sessions enable row level security;
create policy "own focus" on public.focus_sessions for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
create trigger t_profiles before update on public.profiles for each row execute function public.touch_updated_at();
create trigger t_tasks before update on public.tasks for each row execute function public.touch_updated_at();
create trigger t_events before update on public.events for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();