defmodule VilanoKernel.Router.Support do
  @moduledoc false

  alias Plug.Conn
  alias VilanoKernel.Router.RunViews
  alias VilanoKernel.Storage

  def project_payload(body_params) do
    %{
      "name" => fetch_required_string(body_params, "name"),
      "path" => fetch_required_string(body_params, "path"),
      "snapshotPath" => Map.get(body_params, "snapshotPath"),
      "lastSyncedAt" => Map.get(body_params, "lastSyncedAt"),
      "definitionsManifestHash" => Map.get(body_params, "definitionsManifestHash"),
      "definitions" => %{
        "workflows" => get_in(body_params, ["definitions", "workflows"]) || [],
        "services" => get_in(body_params, ["definitions", "services"]) || []
      }
    }
  end

  def fetch_required_string(body_params, key) do
    case Map.get(body_params, key) do
      value when is_binary(value) and value != "" -> value
      _ -> raise ArgumentError, "expected '#{key}' to be a non-empty string"
    end
  end

  def fetch_required_integer(body_params, key) do
    case Map.get(body_params, key) do
      value when is_integer(value) -> value
      _ -> raise ArgumentError, "expected '#{key}' to be an integer"
    end
  end

  def list_definitions(kind, nil), do: {:ok, Storage.list_definitions(kind)}

  def list_definitions(kind, project_name) do
    case Storage.list_definitions(kind, project_name) do
      nil -> {:error, "Unknown project: #{project_name}"}
      definitions -> {:ok, definitions}
    end
  end

  def send_run_inspect(conn, run_id) do
    case Storage.get_run_for_inspect(run_id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{run_id}")

      run ->
        send_json(conn, 200, RunViews.build_run_inspect_body(run, run_id))
    end
  end

  def send_run_replay(conn, run_id) do
    case Storage.get_run_for_inspect(run_id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{run_id}")

      run ->
        send_json(conn, 200, RunViews.build_run_replay_body(run, run_id))
    end
  end

  def maybe_kill_managed_worker(result) do
    case Map.get(result, "activeLeaseWorkerId") do
      worker_id when is_binary(worker_id) ->
        _ = VilanoKernel.ManagedWorker.kill_worker(worker_id, :activation_cancelled)
        :ok

      _ ->
        :ok
    end
  end

  def send_json(conn, status, body) do
    body = Jason.encode!(body)

    conn
    |> Conn.put_resp_content_type("application/json")
    |> Conn.send_resp(status, body <> "\n")
  end

  def send_error(conn, status, code, message) do
    send_json(conn, status, %{ok: false, error: %{code: code, message: message}})
  end
end
