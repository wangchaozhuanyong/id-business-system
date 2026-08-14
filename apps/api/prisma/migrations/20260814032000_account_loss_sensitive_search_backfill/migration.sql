-- Keep loss-reported accounts frozen while allowing technical blind-index maintenance.
CREATE OR REPLACE FUNCTION public.id_business_v2_enforce_reported_account_loss()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.loss_reported_at IS NOT NULL
    AND NEW.loss_reported_at IS NOT NULL
    AND (
      to_jsonb(NEW) - ARRAY[
        'apple_id_search_tokens',
        'phone_search_tokens',
        'updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'apple_id_search_tokens',
        'phone_search_tokens',
        'updated_at'
      ]::text[]
    )
  THEN
    RAISE EXCEPTION 'Loss-reported ID accounts are frozen until unfreeze is completed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.loss_reported_at IS NOT NULL AND (
    NEW.record_status::text <> 'disabled'
    OR NEW.active_loss_record_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_options status_option
      WHERE
        status_option.id = NEW.status_option_id
        AND status_option.type = 'id_status'
        AND status_option.code = 'frozen'
        AND status_option.status::text = 'active'
        AND status_option.is_system = true
        AND status_option.deleted_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_account_losses loss_record
      WHERE
        loss_record.id = NEW.active_loss_record_id
        AND loss_record.account_id = NEW.id
        AND loss_record.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'Loss reporting must freeze the ID account and link an active loss record atomically'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.loss_reported_at IS NOT NULL AND NEW.loss_reported_at IS NULL AND (
    OLD.active_loss_record_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_account_losses loss_record
      WHERE
        loss_record.id = OLD.active_loss_record_id
        AND loss_record.account_id = OLD.id
        AND loss_record.status = 'reversed'
        AND loss_record.reversed_at IS NOT NULL
        AND loss_record.reversal_finance_journal_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Loss-reported ID accounts can only unfreeze after loss reversal is posted'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;
