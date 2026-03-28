defmodule VilanoKernel.Storage.Support.Rows do
  @moduledoc false

  def run_from_row(row) do
    %{
      "id" => row["id"],
      "project" => row["project_name"],
      "definitionKind" => row["definition_kind"],
      "definitionName" => row["definition_name"],
      "projectSnapshotPath" => row["project_snapshot_path"],
      "projectDefinitions" => decode_json_value(row["project_definitions_json"], nil),
      "definition" => definition_from_row(row),
      "status" => row["status"],
      "leaseId" => row["lease_id"],
      "leaseWorkerId" => row["lease_worker_id"],
      "leaseExpiresAt" => row["lease_expires_at"],
      "input" => decode_json_value(row["input_json"], %{}),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def definition_from_row(row) do
    if row["definition_file"] do
      %{
        "kind" => row["definition_kind"],
        "name" => row["definition_name"],
        "file" => row["definition_file"],
        "exportName" => row["definition_export_name"],
        "runtimeKind" => row["definition_runtime_kind"],
        "sourceLanguage" => row["definition_source_language"]
      }
    else
      nil
    end
  end

  def exec_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "name" => row["name"],
      "status" => row["status"],
      "cmd" => row["cmd"],
      "args" => decode_json_list(row["args_json"]),
      "cwd" => row["cwd"],
      "env" => nil,
      "envKeys" => decode_json_map_keys(row["env_json"]),
      "timeoutMs" => row["timeout_ms"],
      "attempt" => row["attempt"],
      "exitCode" => row["exit_code"],
      "signalCode" => row["signal_code"],
      "stdoutRef" => row["stdout_ref"],
      "stderrRef" => row["stderr_ref"],
      "artifacts" => decode_json_list(row["artifacts_json"]),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def wait_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "kind" => row["wait_kind"],
      "name" => row["wait_name"],
      "status" => row["status"],
      "wakeAt" => row["wake_at"],
      "output" => decode_json_value(row["output_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def service_run_from_row(run_row, service_row) do
    run_from_row(run_row)
    |> Map.put("serviceKey", service_row["service_key"])
    |> Map.put("keyInput", decode_json_value(service_row["key_input_json"], %{}))
    |> Map.put("state", decode_json_value(service_row["state_json"], nil))
  end

  def project_record_for_run(run) do
    %{
      "name" => run["project"],
      "path" => run["projectSnapshotPath"] || run["project"],
      "snapshotPath" => run["projectSnapshotPath"],
      "definitions" => project_definitions_for_run(run)
    }
  end

  def project_definitions_for_run(run) do
    run["projectDefinitions"] || %{"workflows" => [], "services" => []}
  end

  def find_singleton_service_definition(project_definitions, role) do
    project_definitions
    |> Map.get("services", [])
    |> Enum.find(&(get_in(&1, ["discovery", "singletonRole"]) == role))
  end

  def definition_from_project_definitions!(definitions, kind, definition_name) do
    bucket =
      case kind do
        "workflow" -> Map.get(definitions, "workflows", [])
        "service" -> Map.get(definitions, "services", [])
      end

    Enum.find(bucket, &(&1["name"] == definition_name)) ||
      raise "Unknown #{kind} definition '#{definition_name}' in stored project snapshot"
  end

  def service_envelope_from_row(row) do
    %{
      "id" => row["id"],
      "serviceRunId" => row["service_run_id"],
      "kind" => row["kind"],
      "name" => row["name"],
      "attempt" => row["attempt"],
      "payload" => decode_json_value(row["payload_json"], nil),
      "correlationId" => row["correlation_id"],
      "senderRunId" => row["sender_run_id"],
      "status" => row["status"],
      "reply" => decode_json_value(row["reply_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "wakeAt" => row["wake_at"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def mailbox_envelope_from_row(row) do
    %{
      "id" => row["id"],
      "kind" => row["kind"],
      "name" => row["name"],
      "attempt" => row["attempt"],
      "correlationId" => row["correlation_id"],
      "senderRunId" => row["sender_run_id"],
      "createdAt" => row["created_at"],
      "wakeAt" => row["wake_at"]
    }
  end

  def deterministic_service_run_id(project_name, definition_name, service_key) do
    digest =
      :crypto.hash(:sha256, "#{project_name}:#{definition_name}:#{service_key}")
      |> Base.encode16(case: :lower)
      |> binary_part(0, 32)

    "run_" <> digest
  end

  def wait_deadline(_now, nil), do: nil

  def wait_deadline(now, timeout_ms) when is_integer(timeout_ms) and timeout_ms > 0 do
    shift_milliseconds(now, timeout_ms)
  end

  def wait_deadline(_now, _timeout_ms), do: nil

  def decode_json_list(nil), do: []
  def decode_json_list(value) when is_binary(value), do: Jason.decode!(value)

  def decode_json_map_keys(nil), do: []

  def decode_json_map_keys(value) when is_binary(value) do
    case Jason.decode!(value) do
      decoded when is_map(decoded) ->
        decoded
        |> Map.keys()
        |> Enum.sort()

      decoded when is_list(decoded) ->
        decoded
        |> Enum.filter(&is_binary/1)
        |> Enum.sort()

      _ ->
        []
    end
  end

  def decode_json_value(nil, fallback), do: fallback
  def decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)

  def maybe_encode_json(nil), do: nil
  def maybe_encode_json(value), do: Jason.encode!(value)

  def shift_seconds(iso8601, seconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()
  end

  def shift_milliseconds(iso8601, milliseconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(milliseconds, :millisecond) |> DateTime.to_iso8601()
  end
end
