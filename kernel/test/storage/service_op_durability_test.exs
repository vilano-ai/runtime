defmodule VilanoKernel.Storage.ServiceOpDurabilityTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage

  setup do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    on_exit(fn ->
      Application.put_env(:vilano_kernel, :runtime, runtime)
      Application.delete_env(:vilano_kernel, :storage_test_hooks)
    end)

    :ok
  end

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

      send_error =
        Storage.resolve_service_send(lease_id, service_run_id, "hint", "send:stopped", %{
          "note" => "x"
        })

      signal_error =
        Storage.resolve_service_signal(lease_id, service_run_id, "reset", "signal:stopped", %{
          "source" => "test"
        })

      ask_error =
        Storage.resolve_service_ask(lease_id, service_run_id, "status", "ask:stopped", %{})

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

      assert Storage.resolve_service_send(lease_id, service_run_id, "hint", "send:stopped", %{
               "note" => "x"
             }) ==
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

      assert Enum.all?(ops, fn op ->
               Jason.decode!(op["error_json"])["message"] == "Service is stopped"
             end)
    after
      SQL.query!(Repo, "delete from run_service_ops where caller_run_id = ?", [caller_run_id])
      SQL.query!(Repo, "delete from service_runs where run_id = ?", [service_run_id])
      SQL.query!(Repo, "delete from runs where id in (?, ?)", [caller_run_id, service_run_id])
    end
  end

  test "service send signal and ask prepare large inbound enqueue payloads before transactions" do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    Application.put_env(:vilano_kernel, :runtime, %{runtime | event_payload_max_bytes: 128})

    parent = self()

    Application.put_env(:vilano_kernel, :storage_test_hooks, %{
      event_payload_prepared: fn payload ->
        send(parent, {:event_payload_prepared, payload})
      end
    })

    now = iso_now()
    expires_at = iso_shift(30)
    service_run_id = "run_" <> Ecto.UUID.generate()

    callers = [
      {"send", "lease_" <> Ecto.UUID.generate(), "run_" <> Ecto.UUID.generate()},
      {"signal", "lease_" <> Ecto.UUID.generate(), "run_" <> Ecto.UUID.generate()},
      {"ask", "lease_" <> Ecto.UUID.generate(), "run_" <> Ecto.UUID.generate()}
    ]

    try do
      insert_service_run!(service_run_id, now, %{status: "idle", service_key: "service-key"})

      Enum.each(callers, fn {kind, lease_id, caller_run_id} ->
        insert_workflow_run!(caller_run_id, now, %{
          definition_name: "caller#{kind}",
          status: "active",
          lease_id: lease_id,
          lease_auth_token: "lease-auth-#{kind}",
          lease_worker_id: "managed-local-1",
          lease_expires_at: expires_at
        })
      end)

      payload = large_payload()

      assert %{"status" => "completed"} =
               Storage.resolve_service_send(
                 lease_for(callers, "send"),
                 service_run_id,
                 "hint",
                 "send:large",
                 payload
               )

      assert %{"status" => "completed"} =
               Storage.resolve_service_signal(
                 lease_for(callers, "signal"),
                 service_run_id,
                 "reset",
                 "signal:large",
                 payload
               )

      assert %{"status" => "suspended"} =
               Storage.resolve_service_ask(
                 lease_for(callers, "ask"),
                 service_run_id,
                 "status",
                 "ask:large",
                 payload
               )

      payloads = drain_prepared_payloads([])

      assert Enum.count(payloads, &(Map.get(&1, :in_transaction?) == false)) >= 6
      refute Enum.any?(payloads, &Map.get(&1, :in_transaction?))
    after
      caller_run_ids =
        Enum.map(callers, fn {_kind, _lease_id, caller_run_id} -> caller_run_id end)

      run_ids = [service_run_id | caller_run_ids]

      Enum.each(caller_run_ids, fn caller_run_id ->
        SQL.query!(Repo, "delete from run_service_ops where caller_run_id = ?", [caller_run_id])
      end)

      Enum.each(run_ids, fn run_id ->
        SQL.query!(Repo, "delete from run_waits where run_id = ?", [run_id])
      end)

      SQL.query!(Repo, "delete from service_envelopes where service_run_id = ?", [service_run_id])
      SQL.query!(Repo, "delete from service_runs where run_id = ?", [service_run_id])

      Enum.each(run_ids, fn run_id ->
        SQL.query!(Repo, "delete from run_event_payload_refs where run_id = ?", [run_id])
        SQL.query!(Repo, "delete from run_events where run_id = ?", [run_id])
        SQL.query!(Repo, "delete from run_event_sequences where run_id = ?", [run_id])
        SQL.query!(Repo, "delete from runs where id = ?", [run_id])
      end)
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
    DateTime.utc_now()
    |> DateTime.add(seconds, :second)
    |> DateTime.truncate(:millisecond)
    |> DateTime.to_iso8601()
  end

  defp lease_for(callers, kind) do
    callers
    |> Enum.find(fn {caller_kind, _lease_id, _caller_run_id} -> caller_kind == kind end)
    |> elem(1)
  end

  defp large_payload do
    %{
      "message" => "large",
      "payload" => String.duplicate("x", 512),
      "nonce" => Ecto.UUID.generate()
    }
  end

  defp drain_prepared_payloads(payloads) do
    receive do
      {:event_payload_prepared, payload} -> drain_prepared_payloads([payload | payloads])
    after
      100 -> Enum.reverse(payloads)
    end
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row -> Enum.zip(columns, row) |> Map.new() end)
  end
end
