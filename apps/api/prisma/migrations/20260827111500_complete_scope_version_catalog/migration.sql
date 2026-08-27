-- These scopes were introduced after the original change-sync catalog was created.
-- Insert only missing metadata rows; existing versions must never be reset or overwritten.
INSERT INTO public.id_business_v2_scope_versions (scope, version)
VALUES
  ('audit-logs', 0),
  ('branding', 0),
  ('dashboard', 0)
ON CONFLICT (scope) DO NOTHING;
