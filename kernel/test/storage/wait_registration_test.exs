defmodule VilanoKernel.Storage.WaitRegistrationTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage

  setup do
    Application.delete_env(:vilano_kernel, :storage_test_hooks)
    on_exit(fn -> Application.delete_env(:vilano_kernel, :storage_test_hooks) end)
    :ok
  end

  test "child result wait completes when the child finishes during wait registration" do
    now = iso_now()
    expires_at = iso_shift(30)
    parent_run_id = "run_" <> Ecto.UUID.generate()
    child_run_id = "run_" <> Ecto.UUID.generate()
    parent_lease_id = "lease_" <> Ecto.UUID.generate()
    child_lease_id = "lease_" <> Ecto.UUID.generate()

    try do
      insert_workflow_run!(parent_run_id, now, %{
        status: "active",
        definition_name: "parentProbe",
        lease_id: parent_lease_id,
        lease_auth_token: "lease-auth-parent",
        lease_worker_id: "managed-local-1",
        lease_expires_at: expires_at
      })

      insert_workflow_run!(child_run_id, now, %{
        status: "active",
        definition_name: "childProbe",
        lease_id: child_lease_id,
        lease_auth_token: "lease-auth-child",
        lease_worker_id: "managed-local-2",
        lease_expires_at: expires_at
      })

      SQL.query!(
        Repo,
        """
        insert into run_children (
          parent_run_id,
          op_key,
          child_run_id,
          definition_name,
          status,
          created_at,
          updated_at
        ) values (?, 'child:probe', ?, 'childProbe', 'created', ?, ?)
        """,
        [parent_run_id, child_run_id, now, now]
      )

      Application.put_env(:vilano_kernel, :storage_test_hooks, %{
        child_wait_registered: fn _payload ->
          Storage.complete_run_lease(child_lease_id, %{"ok" => true})
        end
      })

      assert Storage.resolve_child_result_wait(parent_lease_id, child_run_id, "child:probe") == %{
               "status" => "completed",
               "output" => %{"ok" => true}
             }

      wait =
        SQL.query!(
          Repo,
          "select status, output_json from run_waits where run_id = ? and op_key = 'child_result:' || ?",
          [parent_run_id, child_run_id]
        )
        |> row_map()

      parent_run =
        SQL.query!(Repo, "select status from runs where id = ?", [parent_run_id])
        |> row_map()

      assert wait["status"] == "completed"
      assert Jason.decode!(wait["output_json"]) == %{"ok" => true}
      assert parent_run["status"] == "active"
    after
      SQL.query!(Repo, "delete from run_children where parent_run_id = ?", [parent_run_id])
      SQL.query!(Repo, "delete from run_waits where run_id in (?, ?)", [parent_run_id, child_run_id])
      SQL.query!(Repo, "delete from run_events where run_id in (?, ?)", [parent_run_id, child_run_id])
      SQL.query!(Repo, "delete from run_event_sequences where run_id in (?, ?)", [parent_run_id, child_run_id])
      SQL.query!(Repo, "delete from runs where id in (?, ?)", [parent_run_id, child_run_id])
    end
  end

  test "signal wait completes when a signal arrives during wait registration" do
    now = iso_now()
    expires_at = iso_shift(30)
    run_id = "run_" <> Ecto.UUID.generate()
    lease_id = "lease_" <> Ecto.UUID.generate()

    try do
      insert_workflow_run!(run_id, now, %{
        status: "active",
        definition_name: "signalProbe",
        lease_id: lease_id,
        lease_auth_token: "lease-auth-signal",
        lease_worker_id: "managed-local-1",
        lease_expires_at: expires_at
      })

      Application.put_env(:vilano_kernel, :storage_test_hooks, %{
        signal_wait_registered: fn %{"runId" => signaled_run_id, "signal" => signal_name} ->
          Storage.send_run_signal(signaled_run_id, signal_name, %{"source" => "hook"})
        end
      })

      result = Storage.resolve_signal_wait(lease_id, "approved", "signal:approved")

      assert result["status"] == "completed"
      assert result["output"] == %{"source" => "hook"}
      assert result["wait"]["runId"] == run_id
      assert result["wait"]["key"] == "signal:approved"
      assert result["wait"]["kind"] == "signal"
      assert result["wait"]["name"] == "approved"
      assert result["wait"]["status"] == "completed"
      assert result["wait"]["output"] == %{"source" => "hook"}
      assert result["wait"]["wakeAt"] == nil

      wait =
        SQL.query!(
          Repo,
          "select status, output_json from run_waits where run_id = ? and op_key = 'signal:approved'",
          [run_id]
        )
        |> row_map()

      signal =
        SQL.query!(
          Repo,
          "select consumed_at from run_signals where run_id = ? and signal_name = 'approved'",
          [run_id]
        )
        |> row_map()

      assert wait["status"] == "completed"
      assert Jason.decode!(wait["output_json"]) == %{"source" => "hook"}
      refute is_nil(signal["consumed_at"])
    after
      SQL.query!(Repo, "delete from run_waits where run_id = ?", [run_id])
      SQL.query!(Repo, "delete from run_signals where run_id = ?", [run_id])
      SQL.query!(Repo, "delete from run_events where run_id = ?", [run_id])
      SQL.query!(Repo, "delete from run_event_sequences where run_id = ?", [run_id])
      SQL.query!(Repo, "delete from runs where id = ?", [run_id])
    end
  end

  defp insert_workflow_run!(run_id, now, attrs) do
    status = Map.get(attrs, :status, "pending")
    definition_name = Map.get(attrs, :definition_name, "probe")
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

  defp iso_now do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp iso_shift(seconds) do
    DateTime.utc_now() |> DateTime.add(seconds, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp row_map(%{rows: [row], columns: columns}) do
    Enum.zip(columns, row) |> Map.new()
  end
end
