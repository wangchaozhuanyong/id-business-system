INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES ('employees', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE TRIGGER id_business_v2_users_employee_change
AFTER INSERT OR UPDATE OR DELETE ON public.users
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('employees');

CREATE TRIGGER id_business_v2_user_roles_employee_change
AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('employees');

CREATE TRIGGER id_business_v2_roles_employee_change
AFTER INSERT OR UPDATE OR DELETE ON public.roles
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('employees');

CREATE TRIGGER id_business_v2_auth_identities_employee_change
AFTER INSERT OR UPDATE OR DELETE ON public.v2_auth_identities
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('employees');
