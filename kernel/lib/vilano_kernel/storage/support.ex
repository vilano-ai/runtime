defmodule VilanoKernel.Storage.Support do
  @moduledoc false

  alias VilanoKernel.Storage.Support.{Rows, Sql}

  defdelegate run_from_row(row), to: Rows
  defdelegate definition_from_row(row), to: Rows
  defdelegate exec_from_row(row), to: Rows
  defdelegate wait_from_row(row), to: Rows
  defdelegate service_run_from_row(run_row, service_row), to: Rows
  defdelegate project_record_for_run(run), to: Rows
  defdelegate project_definitions_for_run(run), to: Rows
  defdelegate find_singleton_service_definition(project_definitions, role), to: Rows
  defdelegate definition_from_project_definitions!(definitions, kind, definition_name), to: Rows
  defdelegate service_envelope_from_row(row), to: Rows
  defdelegate mailbox_envelope_from_row(row), to: Rows
  defdelegate deterministic_service_run_id(project_name, definition_name, service_key), to: Rows
  defdelegate shift_seconds(iso8601, seconds), to: Rows
  defdelegate shift_milliseconds(iso8601, milliseconds), to: Rows
  defdelegate wait_deadline(now, timeout_ms), to: Rows
  defdelegate decode_json_list(value), to: Rows
  defdelegate decode_json_map_keys(value), to: Rows
  defdelegate decode_json_value(value, fallback), to: Rows
  defdelegate maybe_encode_json(value), to: Rows

  defdelegate list_service_runs_by_definition(project_name, definition_name), to: Sql
  defdelegate rows_to_maps(result), to: Sql
  defdelegate write_changes!(query, params), to: Sql
  defdelegate first_integer(result), to: Sql
  defdelegate ensure_column!(table_name, column_name, definition), to: Sql
  defdelegate get_run_exec(run_id, op_key), to: Sql
  defdelegate get_run_step_row(run_id, op_key), to: Sql
  defdelegate get_run_wait(run_id, op_key), to: Sql
  defdelegate get_pending_signal(run_id, signal_name), to: Sql
  defdelegate get_run_child(parent_run_id, op_key), to: Sql
  defdelegate get_run_child_by_child(parent_run_id, child_run_id), to: Sql
  defdelegate get_run_service_ref(caller_run_id, service_run_id), to: Sql
  defdelegate related_run_visible?(owner_run_id, target_run_id), to: Sql
  defdelegate record_service_ref!(caller_run_id, service_run_id, now), to: Sql

  defdelegate persist_failed_service_op!(
                caller_run_id,
                op_key,
                service_run_id,
                op_kind,
                message_name,
                correlation_id,
                payload,
                error,
                now
              ),
              to: Sql

  defdelegate persist_failed_service_op_json!(
                caller_run_id,
                op_key,
                service_run_id,
                op_kind,
                message_name,
                correlation_id,
                payload_json,
                error_json,
                now
              ),
              to: Sql

  defdelegate related_run?(caller_run_id, target_run_id), to: Sql
  defdelegate get_service_run(project_name, definition_name, service_key), to: Sql
  defdelegate get_service_run_by_id(run_id), to: Sql
  defdelegate query_service_run(sql, args), to: Sql
  defdelegate get_service_envelope(envelope_id), to: Sql
  defdelegate get_processing_service_envelope_for_run(run_id), to: Sql
  defdelegate get_run_service_op(caller_run_id, op_key), to: Sql
  defdelegate append_event!(run_id, event_type, body, created_at), to: Sql
  defdelegate reserve_next_event_seq!(run_id), to: Sql
  defdelegate insert_workflow_run!(run_id, project, definition, input, now), to: Sql

  def run_storage_test_hook(name, payload) do
    hooks = Application.get_env(:vilano_kernel, :storage_test_hooks, %{})

    case Map.get(hooks, name) do
      hook when is_function(hook, 1) -> hook.(payload)
      _ -> :ok
    end
  end

  def unwrap_transaction_result({:ok, value}), do: value
  def unwrap_transaction_result({:error, reason}), do: raise(reason)
end
