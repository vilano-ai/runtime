defmodule VilanoKernel.Storage.ServiceOpDurabilityTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage

  test "stopped service operations persist failed results durably" do
    now = iso_now()
    expires_at = iso_shift(30)
    caller_run_id = "run_" <> Ecto.UUID.generate()
    service_run_id = "run_" <> Ecto.UUID.generate()
    lease_id = "lease_" <> Ecto.UUID.generate()

    try do
      insert_workflow_run!(caller_run_id, now, %{
        definition_name: "callerProbe",
        status: "active",
        lease_id: lease_id,
        lease_auth_token: "lease-auth-caller",
        lease_worker_id: "managed-local-1",
        lease_expires_at: expires_at
      })

      insert_service_run!(service_run_id, now, %{status: "stopped", service_key: "service-key"})

      send_error = Storage.resolve_service_send(lease_id, service_run_id, "hint", "send:stopped", %{"note" => "x"})
      signal_error = Storage.resolve_service_signal(lease_id, service_run_id, "reset", "signal:stopped", %{"source" => "test"})
      ask_error = Storage.resolve_service_ask(lease_id, service_run_id, "status", "ask:stopped", %{})

      assert send_error["status"] == "failed"
      assert signal_error["status"] == "failed"
      assert ask_error["status"] == "failed"

      # Flip the service back to idle to prove replay stays pinned to the persisted failure.
      SQL.query!(
        Repo,
        """
        update runs
        set status = 'idle', updated_at = ?
        where id = ?
        """,
        [now, service_run_id]
      )

      assert Storage.resolve_service_send(lease_id, service_run_id, "hint", "send:stopped", %{"note" => "x"}) ==
               send_error

      assert Storage.resolve_service_signal(
               lease_id,
               service_run_id,
               "reset",
               "signal:stopped",
               %{"source" => "test"}
             ) == signal_error

      assert Storage.resolve_service_ask(lease_id, service_run_id, "status", "ask:stopped", %{}) ==
               ask_error

      ops =
        SQL.query!(
          Repo,
          """
          select op_key, status, error_json
          from run_service_ops
          where caller_run_id = ?
          order by op_key asc
          """,
          [caller_run_id]
        )
        |> rows_to_maps()

      assert Enum.map(ops, & &1["op_key"]) == ["ask:stopped", "send:stopped", "signal:stopped"]
      assert Enum.all?(ops, &(&1["status"] == "failed"))
      assert Enum.all?(ops, fn op -> Jason.decode!(op["error_json"])["message"] == "Service is stopped" end)
    after
      SQL.query!(Repo, "delete from run_service_ops where caller_run_id = ?", [caller_run_id])
      SQL.query!(Repo, "delete from service_runs where run_id = ?", [service_run_id])
      SQL.query!(Repo, "delete from runs where id in (?, ?)", [caller_run_id, service_run_id])
    end
  end

  defp insert_workflow_run!(run_id, now, attrs) do
    definition_name = Map.get(attrs, :definition_name, "probe")
    status = Map.get(attrs, :status, "pending")
    lease_id = Map.get(attrs, :lease_id)
    lease_auth_token = Map.get(attrs, :lease_auth_token)
    lease_worker_id = Map.get(attrs, :lease_worker_id)
    lease_expires_at = Map.get(attrs, :lease_expires_at)

    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        definition_file,
        definition_export_name,
        definition_runtime_kind,
        definition_source_language,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      ) values (?, 'demo', 'workflow', ?, '/tmp/project', '{}', 'src/definitions.ts', ?, 'javascript', 'typescript', ?, ?, ?, ?, ?, '{}', null, null, ?, ?)
      """,
      [
        run_id,
        definition_name,
        definition_name,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        now,
        now
      ]
    )
  end

  defp insert_service_run!(run_id, now, attrs) do
    status = Map.get(attrs, :status, "idle")
    service_key = Map.get(attrs, :service_key, "service-key")

    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        definition_file,
        definition_export_name,
        definition_runtime_kind,
        definition_source_language,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      ) values (?, 'demo', 'service', 'serviceProbe', '/tmp/project', '{}', 'src/definitions.ts', 'serviceProbe', 'javascript', 'typescript', ?, null, null, null, null, '{}', null, null, ?, ?)
      """,
      [run_id, status, now, now]
    )

    SQL.query!(
      Repo,
      """
      insert into service_runs (
        run_id,
        service_key,
        key_input_json,
        state_json,
        created_at,
        updated_at
      ) values (?, ?, '{}', '{}', ?, ?)
      """,
      [run_id, service_key, now, now]
    )
  end

  defp iso_now do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp iso_shift(seconds) do
    DateTime.utc_now() |> DateTime.add(seconds, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row -> Enum.zip(columns, row) |> Map.new() end)
  end
end
