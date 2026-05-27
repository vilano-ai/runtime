defmodule VilanoKernel.Storage.EventPayloadsTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.EventPayloads
  alias VilanoKernel.Storage.Migrations.CreateRunEventPayloadRefs
  alias VilanoKernel.Storage.ReadModels
  alias VilanoKernel.Storage.Supervision
  alias VilanoKernel.Storage.Support
  alias VilanoKernel.Storage.WorkflowOps

  @ref_marker "__vilano_event_payload_ref__"
  @unavailable_marker "__vilano_event_payload_unavailable__"

  setup do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    runtime_home =
      Path.join(System.tmp_dir!(), "vilano-event-payloads-home-#{Ecto.UUID.generate()}")

    execution_home = Path.join(System.tmp_dir!(), "vilano-event-payloads-#{Ecto.UUID.generate()}")
    artifact_home = Path.join(execution_home, "artifacts")

    Application.put_env(:vilano_kernel, :runtime, %{
      runtime
      | home_dir: runtime_home,
        execution_home_dir: execution_home,
        artifact_home_dir: artifact_home,
        event_payload_max_bytes: 128
    })

    on_exit(fn ->
      Application.put_env(:vilano_kernel, :runtime, runtime)
      File.rm_rf(runtime_home)
      File.rm_rf(execution_home)
    end)

    {:ok,
     runtime_home: runtime_home, execution_home: execution_home, artifact_home: artifact_home}
  end

  test "small events remain inline", %{runtime_home: runtime_home} do
    run_id = run_id()
    body = %{"message" => "small"}

    try do
      Support.append_event!(run_id, "SmallEvent", body, now())

      [row] = event_rows(run_id)
      stored_body = Jason.decode!(row["body_json"])

      assert stored_body == body
      refute Map.has_key?(stored_body, @ref_marker)
      assert payload_ref_rows(run_id) == []
      refute File.exists?(Path.join(runtime_home, "event-payloads"))

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
    after
      cleanup_run_events(run_id)
    end
  end

  test "large events are externalized and hydrated", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()
    body_json = Jason.encode!(body)

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert ref["bytes"] == byte_size(body_json)
      assert ref["sha256"] == sha256_hex(body_json)
      assert String.starts_with?(ref["path"], "event-payloads/")
      assert byte_size(row["body_json"]) < byte_size(body_json)

      assert [payload_ref] = payload_ref_rows(run_id)
      assert payload_ref["event_id"] == row["id"]
      assert payload_ref["run_id"] == run_id
      assert payload_ref["payload_path"] == ref["path"]
      assert payload_ref["sha256"] == ref["sha256"]
      assert payload_ref["bytes"] == ref["bytes"]

      payload_path = Path.join(runtime_home, ref["path"])
      assert File.exists?(payload_path)
      refute File.exists?(Path.join(execution_home, ref["path"]))
      assert File.read!(payload_path) == body_json

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
    after
      cleanup_run_events(run_id)
    end
  end

  test "large payload preparation publishes outside DB transactions", %{
    runtime_home: runtime_home
  } do
    body = large_body()
    body_json = Jason.encode!(body)
    storage = EventPayloads.prepare_body_for_storage!(body)
    ref = Jason.decode!(storage.body_json)
    payload_path = Path.join(runtime_home, ref["path"])

    try do
      EventPayloads.publish_prepared_payload!(storage)

      assert File.exists?(payload_path)
      assert File.read!(payload_path) == body_json

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []
    after
      EventPayloads.discard_prepared_payload!(storage)
    end
  end

  test "garbage collection removes stale staged payload temp files without pruning staging dirs",
       %{
         runtime_home: runtime_home
       } do
    stale_path =
      Path.join([
        runtime_home,
        "event-payloads-staging",
        "aa",
        "#{String.duplicate("a", 64)}.stale.tmp"
      ])

    fresh_path =
      Path.join([
        runtime_home,
        "event-payloads-staging",
        "bb",
        "#{String.duplicate("b", 64)}.fresh.tmp"
      ])

    File.mkdir_p!(Path.dirname(stale_path))
    File.mkdir_p!(Path.dirname(fresh_path))
    File.write!(stale_path, "stale")
    File.write!(fresh_path, "fresh")
    assert force_old_mtime(stale_path)

    EventPayloads.garbage_collect!(60_000)

    refute File.exists?(stale_path)
    assert File.dir?(Path.dirname(stale_path))
    assert File.exists?(fresh_path)

    EventPayloads.garbage_collect!(0)

    refute File.exists?(fresh_path)
    assert File.dir?(Path.dirname(fresh_path))
    assert File.dir?(Path.join(runtime_home, "event-payloads-staging"))
  end

  test "garbage collection removes stale canonical payload temp files", %{
    runtime_home: runtime_home
  } do
    stale_sha = String.duplicate("a", 64)
    fresh_sha = String.duplicate("b", 64)

    stale_path =
      Path.join([
        runtime_home,
        "event-payloads",
        "aa",
        ".#{stale_sha}.json.1.tmp"
      ])

    fresh_path =
      Path.join([
        runtime_home,
        "event-payloads",
        "bb",
        ".#{fresh_sha}.json.2.tmp"
      ])

    File.mkdir_p!(Path.dirname(stale_path))
    File.mkdir_p!(Path.dirname(fresh_path))
    File.write!(stale_path, "stale")
    File.write!(fresh_path, "fresh")
    assert force_old_mtime(stale_path)

    EventPayloads.garbage_collect!(60_000)

    refute File.exists?(stale_path)
    assert File.exists?(fresh_path)

    EventPayloads.garbage_collect!(0)

    refute File.exists?(fresh_path)
  end

  test "workflow creation externalizes prepared RunStarted payloads", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = workflow_definition()
    input = large_body()

    try do
      run = Storage.create_workflow_run!(project, definition, input)

      assert %{"id" => run_id} = run
      assert [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert [payload_ref] = payload_ref_rows(run_id)
      assert payload_ref["event_id"] == row["id"]
      assert payload_ref["payload_path"] == ref["path"]

      payload_path = Path.join(runtime_home, ref["path"])
      assert File.exists?(payload_path)

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["type"] == "RunStarted"
      assert event["body"]["input"] == input
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "workflow creation leaves no prepared RunStarted payload staging on failure", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = Map.delete(workflow_definition(), "file")

    try do
      assert_raise KeyError, fn ->
        Storage.create_workflow_run!(project, definition, large_body())
      end

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "child workflow spawn externalizes prepared RunStarted payloads", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = workflow_definition()
    input = large_body()
    lease_id = "lease_" <> Ecto.UUID.generate()
    child_run_id = run_id()
    restore_hooks = install_payload_prepare_hook(self())

    on_exit(restore_hooks)

    try do
      parent_run = Storage.create_workflow_run!(project, definition, %{"parent" => true})
      activate_run_for_lease!(parent_run["id"], lease_id)

      assert %{"status" => "created", "childRun" => %{"id" => ^child_run_id}} =
               WorkflowOps.resolve_spawn(lease_id, "workflow", "child:1", child_run_id, input)

      [row] = event_rows(child_run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert [_payload_ref] = payload_ref_rows(child_run_id)
      assert File.exists?(Path.join(runtime_home, ref["path"]))

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []

      spawned_row =
        parent_run["id"]
        |> event_rows()
        |> Enum.find(&(&1["event_type"] == "ChildRunSpawned"))

      spawned_ref = Jason.decode!(spawned_row["body_json"])
      assert spawned_ref[@ref_marker] == 1
      assert File.exists?(Path.join(runtime_home, spawned_ref["path"]))

      assert payload_ref_rows(parent_run["id"])
             |> Enum.any?(&(&1["event_id"] == spawned_row["id"]))

      assert [event] = ReadModels.list_run_events(child_run_id)
      assert event["type"] == "RunStarted"
      assert event["body"]["input"] == input

      assert_prepared_payloads_outside_transaction_at_least(2)
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "supervised member spawn externalizes prepared RunStarted payloads", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = workflow_definition()
    input = large_body()
    lease_id = "lease_" <> Ecto.UUID.generate()

    try do
      owner_run = Storage.create_workflow_run!(project, definition, %{"owner" => true})
      activate_run_for_lease!(owner_run["id"], lease_id)

      group =
        Supervision.resolve_supervision_group(
          lease_id,
          "supervision:1",
          "one_for_one",
          3,
          60_000,
          "fail"
        )

      restore_hooks = install_payload_prepare_hook(self())
      on_exit(restore_hooks)

      assert %{"currentChildRunId" => child_run_id} =
               Supervision.resolve_supervised_spawn(
                 lease_id,
                 group["id"],
                 "workflow",
                 "member-a",
                 input
               )

      [row] = event_rows(child_run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert [_payload_ref] = payload_ref_rows(child_run_id)
      assert File.exists?(Path.join(runtime_home, ref["path"]))

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []

      member_row =
        owner_run["id"]
        |> event_rows()
        |> Enum.find(&(&1["event_type"] == "SupervisionMemberSpawned"))

      member_ref = Jason.decode!(member_row["body_json"])
      assert member_ref[@ref_marker] == 1
      assert File.exists?(Path.join(runtime_home, member_ref["path"]))
      assert payload_ref_rows(owner_run["id"]) |> Enum.any?(&(&1["event_id"] == member_row["id"]))

      assert [event] = ReadModels.list_run_events(child_run_id)
      assert event["type"] == "RunStarted"
      assert event["body"]["input"] == input

      assert_prepared_payloads_outside_transaction_at_least(2)
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "supervised child failure externalizes terminal and restart payloads", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = workflow_definition()
    input = large_body()
    error_body = large_body()
    owner_lease_id = "lease_" <> Ecto.UUID.generate()
    child_lease_id = "lease_" <> Ecto.UUID.generate()

    try do
      owner_run = Storage.create_workflow_run!(project, definition, %{"owner" => true})
      activate_run_for_lease!(owner_run["id"], owner_lease_id)

      group =
        Supervision.resolve_supervision_group(
          owner_lease_id,
          "supervision:restart",
          "one_for_one",
          3,
          60_000,
          "fail"
        )

      assert %{"currentChildRunId" => child_run_id} =
               Supervision.resolve_supervised_spawn(
                 owner_lease_id,
                 group["id"],
                 "workflow",
                 "member-a",
                 input
               )

      activate_run_for_lease!(child_run_id, child_lease_id)

      assert %{"id" => ^child_run_id, "status" => "failed"} =
               Storage.fail_run_lease(child_lease_id, error_body)

      assert %{"currentChildRunId" => restart_run_id, "generation" => 2} =
               Supervision.get_supervision_member_status(
                 owner_lease_id,
                 group["id"],
                 "member-a"
               )

      refute restart_run_id == child_run_id

      failed_row =
        child_run_id
        |> event_rows()
        |> Enum.find(&(&1["event_type"] == "RunFailed"))

      failed_ref = Jason.decode!(failed_row["body_json"])
      assert failed_ref[@ref_marker] == 1
      assert payload_ref_rows(child_run_id) |> Enum.any?(&(&1["event_id"] == failed_row["id"]))
      assert File.exists?(Path.join(runtime_home, failed_ref["path"]))

      restart_row =
        restart_run_id
        |> event_rows()
        |> Enum.find(&(&1["event_type"] == "RunStarted"))

      restart_ref = Jason.decode!(restart_row["body_json"])
      assert restart_ref[@ref_marker] == 1
      assert [_payload_ref] = payload_ref_rows(restart_run_id)
      assert File.exists?(Path.join(runtime_home, restart_ref["path"]))

      assert Path.wildcard(Path.join([runtime_home, "event-payloads-staging", "*", "*.tmp"])) ==
               []

      assert [failed_event] =
               child_run_id
               |> ReadModels.list_run_events()
               |> Enum.filter(&(&1["type"] == "RunFailed"))

      assert failed_event["body"]["error"] == error_body

      assert [started_event] = ReadModels.list_run_events(restart_run_id)
      assert started_event["type"] == "RunStarted"
      assert started_event["body"]["input"] == input
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "workflow cancellation prepares RunCancelled payload before admin transaction", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_name = project_name()
    project = workflow_project(project_name, execution_home)
    definition = workflow_definition()
    parent = self()
    original_hooks = Application.get_env(:vilano_kernel, :storage_test_hooks)
    reason = String.duplicate("large-cancel-reason", 32)

    on_exit(fn ->
      case original_hooks do
        nil -> Application.delete_env(:vilano_kernel, :storage_test_hooks)
        hooks -> Application.put_env(:vilano_kernel, :storage_test_hooks, hooks)
      end
    end)

    try do
      run = Storage.create_workflow_run!(project, definition, %{"cancel" => true})

      Application.put_env(:vilano_kernel, :storage_test_hooks, %{
        event_payload_prepared: fn payload ->
          send(parent, {:event_payload_prepared, payload})
        end
      })

      assert %{
               "run" => %{"id" => run_id, "status" => "cancelled"},
               "cancelledWaitCount" => 0,
               "cancelledChildRunCount" => 0,
               "cancelledServiceAskCount" => 0
             } = Storage.cancel_run(run["id"], reason)

      assert_receive {:event_payload_prepared, %{in_transaction?: false}}
      refute_receive {:event_payload_prepared, %{in_transaction?: true}}, 100

      cancelled_row =
        run_id
        |> event_rows()
        |> Enum.find(&(&1["event_type"] == "RunCancelled"))

      ref = Jason.decode!(cancelled_row["body_json"])
      assert ref[@ref_marker] == 1
      assert payload_ref_rows(run_id) |> Enum.any?(&(&1["event_id"] == cancelled_row["id"]))
      assert File.exists?(Path.join(runtime_home, ref["path"]))

      assert [cancelled_event] =
               run_id
               |> ReadModels.list_run_events()
               |> Enum.filter(&(&1["type"] == "RunCancelled"))

      assert cancelled_event["body"]["reason"] == reason
      assert cancelled_event["body"]["cancelledWaitCount"] == 0
    after
      cleanup_project_runtime(project_name)
    end
  end

  test "zero payload cap externalizes events", %{runtime_home: runtime_home} do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    Application.put_env(:vilano_kernel, :runtime, %{runtime | event_payload_max_bytes: 0})

    run_id = run_id()
    body = %{"message" => "small"}
    body_json = Jason.encode!(body)

    try do
      Support.append_event!(run_id, "SmallEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert ref["bytes"] == byte_size(body_json)
      assert ref["sha256"] == sha256_hex(body_json)
      assert File.read!(Path.join(runtime_home, ref["path"])) == body_json

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
    after
      cleanup_run_events(run_id)
    end
  end

  test "externalized payload replay survives execution home changes", %{
    runtime_home: runtime_home
  } do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    new_execution_home =
      Path.join(System.tmp_dir!(), "vilano-event-payloads-exec-#{Ecto.UUID.generate()}")

    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      assert File.exists?(Path.join(runtime_home, ref["path"]))

      Application.put_env(:vilano_kernel, :runtime, %{
        runtime
        | execution_home_dir: new_execution_home
      })

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
      refute File.exists?(Path.join(new_execution_home, ref["path"]))
    after
      Application.put_env(:vilano_kernel, :runtime, runtime)
      File.rm_rf(new_execution_home)
      cleanup_run_events(run_id)
    end
  end

  test "hydrates pre-change execution-home payload refs after canonical root move", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()
    body_json = Jason.encode!(body)
    ref = payload_ref_for_body_json(body_json)

    try do
      legacy_payload_path = write_payload_file!(execution_home, ref, body_json)
      event_id = insert_legacy_run_event!(run_id, Jason.encode!(ref))
      EventPayloads.insert_payload_ref!(event_id, run_id, ref, now())

      canonical_payload_path = Path.join(runtime_home, ref["path"])
      refute File.exists?(canonical_payload_path)
      assert [_payload_ref] = payload_ref_rows(run_id)

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]

      EventPayloads.garbage_collect!(0)
      assert File.exists?(legacy_payload_path)
      refute File.exists?(canonical_payload_path)
    after
      cleanup_run_events(run_id)
    end
  end

  test "garbage collection removes unreferenced legacy execution-home payloads", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    body_json = Jason.encode!(large_body())
    ref = payload_ref_for_body_json(body_json)
    legacy_payload_path = write_payload_file!(execution_home, ref, body_json)
    canonical_payload_path = Path.join(runtime_home, ref["path"])

    refute File.exists?(canonical_payload_path)
    assert File.exists?(legacy_payload_path)

    EventPayloads.garbage_collect!(0)

    refute File.exists?(legacy_payload_path)
    refute File.exists?(canonical_payload_path)
  end

  test "falls back to legacy execution-home payload when canonical file is invalid", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()
    body_json = Jason.encode!(body)
    ref = payload_ref_for_body_json(body_json)

    try do
      write_payload_file!(execution_home, ref, body_json)

      canonical_payload_path =
        write_payload_file!(runtime_home, ref, String.duplicate("x", ref["bytes"]))

      event_id = insert_legacy_run_event!(run_id, Jason.encode!(ref))
      EventPayloads.insert_payload_ref!(event_id, run_id, ref, now())

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
      assert File.exists?(canonical_payload_path)
    after
      cleanup_run_events(run_id)
    end
  end

  test "invalid inline payload refs are returned unchanged" do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    Application.put_env(:vilano_kernel, :runtime, %{runtime | event_payload_max_bytes: 2_048})

    run_id = run_id()

    bodies = [
      %{@ref_marker => 1},
      %{
        @ref_marker => 1,
        "sha256" => "not-a-sha",
        "bytes" => 12,
        "path" => "event-payloads/no/not-a-sha.json"
      }
    ]

    try do
      Enum.each(bodies, &Support.append_event!(run_id, "InlineEvent", &1, now()))

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == bodies
    after
      cleanup_run_events(run_id)
    end
  end

  test "valid payload-ref-shaped event bodies are externalized to avoid replay collisions", %{
    runtime_home: runtime_home
  } do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    Application.put_env(:vilano_kernel, :runtime, %{runtime | event_payload_max_bytes: 2_048})

    run_id = run_id()
    body = valid_ref_shaped_body()
    body_json = Jason.encode!(body)

    try do
      Support.append_event!(run_id, "InlineEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])

      assert ref[@ref_marker] == 1
      assert ref["bytes"] == byte_size(body_json)
      assert ref["sha256"] == sha256_hex(body_json)
      assert File.read!(Path.join(runtime_home, ref["path"])) == body_json
      assert [_payload_ref] = payload_ref_rows(run_id)

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
    after
      cleanup_run_events(run_id)
    end
  end

  test "repeated large event bodies reuse one payload file", %{runtime_home: runtime_home} do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())
      Support.append_event!(run_id, "LargeEvent", body, now())

      refs =
        run_id
        |> event_rows()
        |> Enum.map(fn row -> Jason.decode!(row["body_json"]) end)

      assert length(refs) == 2
      assert Enum.map(refs, & &1["path"]) |> Enum.uniq() |> length() == 1
      assert Enum.map(refs, & &1["sha256"]) |> Enum.uniq() |> length() == 1
      assert length(payload_ref_rows(run_id)) == 2

      payload_files = Path.wildcard(Path.join([runtime_home, "event-payloads", "*", "*.json"]))
      assert length(payload_files) == 1

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body, body]
    after
      cleanup_run_events(run_id)
    end
  end

  test "garbage collection waits for uncommitted payload event appends", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()
    parent = self()

    append_task =
      Task.async(fn ->
        Repo.transaction(fn ->
          Support.append_event!(run_id, "LargeEvent", body, now())

          [ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
          payload_path = Path.join(runtime_home, ref["path"])
          send(parent, {:payload_written, payload_path})

          receive do
            :commit -> :ok
          after
            5_000 -> Repo.rollback(:commit_timeout)
          end
        end)
      end)

    try do
      assert_receive {:payload_written, payload_path}, 1_000
      assert File.exists?(payload_path)

      gc_task =
        Task.async(fn ->
          EventPayloads.garbage_collect!(0)
        end)

      refute Task.yield(gc_task, 100)
      assert File.exists?(payload_path)

      send(append_task.pid, :commit)
      assert {:ok, :ok} = Task.await(append_task)
      assert Task.await(gc_task) == :ok

      assert File.exists?(payload_path)
      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
    after
      if Process.alive?(append_task.pid) do
        send(append_task.pid, :commit)
        Task.yield(append_task, 1_000) || Task.shutdown(append_task, :brutal_kill)
      end

      cleanup_run_events(run_id)
    end
  end

  test "reused unreferenced payloads refresh mtime before garbage collection", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
      payload_path = Path.join(runtime_home, ref["path"])

      cleanup_run_events(run_id)

      forced_old_mtime? = force_old_mtime(payload_path)
      old_mtime = File.stat!(payload_path, time: :posix).mtime

      Support.append_event!(run_id, "LargeEvent", body, now())

      [reused_ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
      assert reused_ref["path"] == ref["path"]

      refreshed_mtime = File.stat!(payload_path, time: :posix).mtime

      if forced_old_mtime? do
        assert refreshed_mtime > old_mtime
      end

      cleanup_run_events(run_id)

      EventPayloads.garbage_collect!(60_000)
      assert File.exists?(payload_path)

      EventPayloads.garbage_collect!(0)
      refute File.exists?(payload_path)
    after
      cleanup_run_events(run_id)
    end
  end

  test "corrupt existing payload file is rewritten before reuse", %{runtime_home: runtime_home} do
    run_id = run_id()
    body = large_body()
    body_json = Jason.encode!(body)

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
      payload_path = Path.join(runtime_home, ref["path"])
      File.write!(payload_path, String.duplicate("x", ref["bytes"]))
      cleanup_run_events(run_id)

      Support.append_event!(run_id, "LargeEvent", body, now())

      [reused_ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
      assert reused_ref["path"] == ref["path"]
      assert File.read!(payload_path) == body_json
      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
    after
      cleanup_run_events(run_id)
    end
  end

  test "missing payload returns unavailable marker instead of crashing", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      File.rm!(Path.join(runtime_home, ref["path"]))

      assert [event] = ReadModels.list_run_events(run_id)
      unavailable = event["body"]

      assert unavailable[@unavailable_marker] == 1
      assert unavailable["reason"] == "missing"
      assert unavailable["sha256"] == ref["sha256"]
      assert unavailable["bytes"] == ref["bytes"]
      assert unavailable["path"] == ref["path"]
    after
      cleanup_run_events(run_id)
    end
  end

  test "corrupt payload returns unavailable marker instead of crashing", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      payload_path = Path.join(runtime_home, ref["path"])
      File.write!(payload_path, String.duplicate("x", ref["bytes"]))

      assert [event] = ReadModels.list_run_events(run_id)
      unavailable = event["body"]

      assert unavailable[@unavailable_marker] == 1
      assert unavailable["reason"] == "sha256_mismatch"
      assert unavailable["sha256"] == ref["sha256"]
      assert unavailable["bytes"] == ref["bytes"]
      assert unavailable["path"] == ref["path"]
    after
      cleanup_run_events(run_id)
    end
  end

  test "garbage collect keeps new unreferenced payloads during default grace", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      payload_path = Path.join(runtime_home, ref["path"])

      cleanup_run_events(run_id)

      EventPayloads.garbage_collect!()
      assert File.exists?(payload_path)

      EventPayloads.garbage_collect!(0)
      refute File.exists?(payload_path)
    after
      cleanup_run_events(run_id)
    end
  end

  test "project runtime purge immediately removes only unreferenced payload files", %{
    runtime_home: runtime_home,
    execution_home: execution_home
  } do
    project_a = project_name()
    project_b = project_name()
    run_a = run_id()
    run_b = run_id()
    body = large_body()

    try do
      insert_project_runtime!(project_a, run_a, execution_home)
      insert_project_runtime!(project_b, run_b, execution_home)

      Support.append_event!(run_a, "LargeEvent", body, now())
      Support.append_event!(run_b, "LargeEvent", body, now())

      assert [_] = payload_ref_rows(run_a)
      assert [_] = payload_ref_rows(run_b)

      [ref_a] = event_rows(run_a) |> Enum.map(&Jason.decode!(&1["body_json"]))
      [ref_b] = event_rows(run_b) |> Enum.map(&Jason.decode!(&1["body_json"]))
      assert ref_a["path"] == ref_b["path"]

      payload_path = Path.join(runtime_home, ref_a["path"])
      assert File.exists?(payload_path)

      assert %{"purgedRunCount" => 1} = Storage.purge_project_runtime(project_a)
      assert [] = payload_ref_rows(run_a)
      assert [_] = payload_ref_rows(run_b)

      assert File.exists?(payload_path)
      assert ReadModels.list_run_events(run_b) |> Enum.map(& &1["body"]) == [body]

      assert %{"purgedRunCount" => 1} = Storage.purge_project_runtime(project_b)
      assert [] = payload_ref_rows(run_b)

      refute File.exists?(payload_path)
    after
      cleanup_project_runtime(project_a)
      cleanup_project_runtime(project_b)
    end
  end

  test "runtime prune removes orphan exec artifacts but keeps referenced artifacts", %{
    artifact_home: artifact_home,
    execution_home: execution_home
  } do
    project = project_name()
    run_id = run_id()
    active_run_id = run_id()
    active_lease_id = "lease_" <> Ecto.UUID.generate()
    now = now()

    referenced_ref =
      Path.join(["artifacts", "runs", run_id, "execs", "op", "attempt-1", "stdout.txt"])

    historical_event_ref =
      Path.join(["custom", "history", run_id, "attempt-0", "stdout.txt"])

    active_ref =
      Path.join(["artifacts", "runs", active_run_id, "execs", "op", "attempt-1", "stdout.txt"])

    terminal_orphan_ref =
      Path.join(["artifacts", "runs", run_id, "execs", "other", "attempt-1", "unreferenced.txt"])

    orphan_ref =
      Path.join(["artifacts", "runs", "orphan", "execs", "op", "attempt-1", "stdout.txt"])

    referenced_path = Path.join(artifact_home, referenced_ref)
    historical_event_path = Path.join(artifact_home, historical_event_ref)
    active_path = Path.join(artifact_home, active_ref)
    terminal_orphan_path = Path.join(artifact_home, terminal_orphan_ref)
    orphan_path = Path.join(artifact_home, orphan_ref)

    active_empty_dir =
      Path.join([artifact_home, "runs", active_run_id, "execs", "empty", "attempt-1"])

    orphan_empty_dir =
      Path.join([artifact_home, "runs", "orphan_empty", "execs", "empty", "attempt-1"])

    active_temp_workspace =
      Path.join([execution_home, "worker-home", "run-workspaces", "#{active_lease_id}.tmp-copy"])

    try do
      insert_project_runtime!(project, run_id, execution_home)

      SQL.query!(
        Repo,
        """
        insert into runs (
          id,
          project_name,
          definition_kind,
          definition_name,
          status,
          lease_id,
          lease_expires_at,
          input_json,
          created_at,
          updated_at
        ) values (?, ?, 'workflow', 'workflow', 'running', ?, ?, '{}', ?, ?)
        """,
        [
          active_run_id,
          project,
          active_lease_id,
          DateTime.add(DateTime.utc_now(), 60, :second) |> DateTime.to_iso8601(),
          now,
          now
        ]
      )

      File.mkdir_p!(Path.dirname(referenced_path))
      File.mkdir_p!(Path.dirname(historical_event_path))
      File.mkdir_p!(Path.dirname(active_path))
      File.mkdir_p!(Path.dirname(terminal_orphan_path))
      File.mkdir_p!(Path.dirname(orphan_path))
      File.mkdir_p!(active_empty_dir)
      File.mkdir_p!(orphan_empty_dir)
      File.mkdir_p!(active_temp_workspace)
      File.write!(referenced_path, "referenced")
      File.write!(historical_event_path, "historical")
      File.write!(active_path, "active")
      File.write!(terminal_orphan_path, "terminal orphan")
      File.write!(orphan_path, "orphan")
      assert force_old_mtime(referenced_path)
      assert force_old_mtime(historical_event_path)
      assert force_old_mtime(active_path)
      assert force_old_mtime(terminal_orphan_path)
      assert force_old_mtime(orphan_path)
      assert force_old_mtime(active_empty_dir)
      assert force_old_mtime(orphan_empty_dir)
      assert force_old_mtime(active_temp_workspace)

      SQL.query!(
        Repo,
        """
        insert into run_execs (
          run_id,
          op_key,
          name,
          status,
          cmd,
          args_json,
          cwd,
          env_json,
          timeout_ms,
          attempt,
          exit_code,
          signal_code,
          stdout_ref,
          stderr_ref,
          artifacts_json,
          output_json,
          error_json,
          created_at,
          updated_at
        ) values (?, 'op', 'exec', 'completed', 'echo', '[]', null, null, null, 1, 0, null, ?, null, '[]', null, null, ?, ?)
        """,
        [run_id, referenced_ref, now, now]
      )

      Support.append_event!(
        run_id,
        "ProcessFailed",
        %{
          "name" => "exec",
          "key" => "op",
          "attempt" => 0,
          "stdoutRef" => historical_event_ref,
          "stderrRef" => nil,
          "artifacts" => [],
          "error" => large_body()
        },
        now
      )

      pruned =
        Storage.prune_runtime(%{
          "artifactGraceSeconds" => 0,
          "eventPayloadGraceSeconds" => 0,
          "runWorkspaceTtlSeconds" => 0,
          "projectSnapshotGraceSeconds" => 300
        })

      assert pruned.ok == true
      assert pruned.artifacts["removedCount"] >= 1
      assert File.exists?(referenced_path)
      assert File.exists?(historical_event_path)
      assert File.exists?(active_path)
      assert File.dir?(active_empty_dir)
      assert File.dir?(active_temp_workspace)
      refute File.exists?(terminal_orphan_path)
      refute File.exists?(orphan_path)
      refute File.exists?(orphan_empty_dir)
    after
      SQL.query!(Repo, "delete from run_execs where run_id = ?", [run_id])
      cleanup_project_runtime(project)
    end
  end

  test "runtime prune keeps completed workflow runs with live service traffic", %{
    execution_home: execution_home
  } do
    project = project_name()
    ref_caller_run_id = run_id()
    envelope_sender_run_id = run_id()
    ref_service_run_id = run_id()
    envelope_service_run_id = run_id()
    envelope_id = "env_" <> Ecto.UUID.generate()
    old = old_iso8601()
    now = now()

    try do
      insert_project_runtime!(project, ref_caller_run_id, execution_home)
      insert_workflow_run!(project, envelope_sender_run_id, now)

      SQL.query!(
        Repo,
        """
        update runs
        set created_at = ?, updated_at = ?
        where id in (?, ?)
        """,
        [old, old, ref_caller_run_id, envelope_sender_run_id]
      )

      insert_service_run!(project, ref_service_run_id, now)
      insert_service_run!(project, envelope_service_run_id, now)

      SQL.query!(
        Repo,
        """
        insert into run_service_refs (
          caller_run_id,
          service_run_id,
          created_at
        ) values (?, ?, ?)
        """,
        [ref_caller_run_id, ref_service_run_id, now]
      )

      SQL.query!(
        Repo,
        """
        insert into service_envelopes (
          id,
          service_run_id,
          kind,
          name,
          attempt,
          payload_json,
          correlation_id,
          sender_run_id,
          status,
          reply_json,
          error_json,
          wake_at,
          created_at,
          updated_at
        ) values (?, ?, 'signal', 'keepSender', null, '{}', null, ?, 'queued', null, null, null, ?, ?)
        """,
        [envelope_id, envelope_service_run_id, envelope_sender_run_id, now, now]
      )

      pruned =
        Storage.prune_runtime(%{
          "completedRunTtlSeconds" => 0,
          "eventPayloadGraceSeconds" => 0,
          "runWorkspaceTtlSeconds" => 86_400,
          "projectSnapshotGraceSeconds" => 300,
          "artifactGraceSeconds" => 300
        })

      assert pruned.ok == true
      assert pruned.completedRuns["eligibleCount"] >= 2
      assert pruned.completedRuns["skippedUnsafeCount"] >= 2
      assert run_exists?(ref_caller_run_id)
      assert run_exists?(envelope_sender_run_id)
      assert service_envelope_exists?(envelope_id)
    after
      SQL.query!(Repo, "delete from service_envelopes where id = ?", [envelope_id])

      SQL.query!(
        Repo,
        """
        delete from run_service_refs
        where caller_run_id in (?, ?) or service_run_id in (?, ?)
        """,
        [
          ref_caller_run_id,
          envelope_sender_run_id,
          ref_service_run_id,
          envelope_service_run_id
        ]
      )

      SQL.query!(
        Repo,
        "delete from service_runs where run_id in (?, ?)",
        [ref_service_run_id, envelope_service_run_id]
      )

      cleanup_project_runtime(project)
    end
  end

  test "garbage collection removes orphan payloads with unrelated marker rows present", %{
    runtime_home: runtime_home
  } do
    legacy_run_id = run_id()
    body = large_body()

    legacy_body_json =
      Jason.encode!(%{
        @ref_marker => 1,
        "legacy" => String.duplicate("x", 2_000_000)
      })

    try do
      storage = EventPayloads.body_for_storage!(body)
      ref = Jason.decode!(storage.body_json)
      payload_path = Path.join(runtime_home, ref["path"])
      assert File.exists?(payload_path)

      insert_legacy_run_event!(legacy_run_id, legacy_body_json)

      assert EventPayloads.garbage_collect!(0) == :ok
      refute File.exists?(payload_path)

      assert [%{"body_json" => ^legacy_body_json}] = event_rows(legacy_run_id)
    after
      cleanup_run_events(legacy_run_id)
    end
  end

  test "garbage collection treats unindexed externalized payload files as orphans after grace", %{
    runtime_home: runtime_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      storage = EventPayloads.body_for_storage!(body)
      ref = Jason.decode!(storage.body_json)
      insert_legacy_run_event!(run_id, storage.body_json)

      payload_path = Path.join(runtime_home, ref["path"])
      assert File.exists?(payload_path)
      assert payload_ref_rows(run_id) == []

      assert EventPayloads.garbage_collect!() == :ok
      assert File.exists?(payload_path)
      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]

      assert EventPayloads.garbage_collect!(0) == :ok
      refute File.exists?(payload_path)

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"][@unavailable_marker] == 1
      assert event["body"]["reason"] == "missing"
    after
      cleanup_run_events(run_id)
    end
  end

  test "migration creates ref infrastructure without backfilling legacy event bodies" do
    inline_run_id = run_id()
    ref_run_id = run_id()
    inline_body_json = Jason.encode!(%{"legacy" => String.duplicate("x", 2_000_000)})
    body = large_body()

    try do
      storage = EventPayloads.body_for_storage!(body)

      insert_legacy_run_event!(inline_run_id, inline_body_json)
      insert_legacy_run_event!(ref_run_id, storage.body_json)

      assert payload_ref_rows(inline_run_id) == []
      assert payload_ref_rows(ref_run_id) == []

      CreateRunEventPayloadRefs.up()

      assert payload_ref_rows(inline_run_id) == []
      assert payload_ref_rows(ref_run_id) == []
      assert [%{"body_json" => ^inline_body_json}] = event_rows(inline_run_id)
      assert ReadModels.list_run_events(ref_run_id) |> Enum.map(& &1["body"]) == [body]
    after
      cleanup_run_events(inline_run_id)
      cleanup_run_events(ref_run_id)
    end
  end

  defp event_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select id, event_type, body_json, created_at
      from run_events
      where run_id = ?
      order by seq asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  defp payload_ref_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select event_id, run_id, payload_path, sha256, bytes, created_at
      from run_event_payload_refs
      where run_id = ?
      order by created_at asc, event_id asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  defp first_integer(%{rows: [[value | _rest] | _rows]}) when is_integer(value), do: value
  defp first_integer(_result), do: 0

  defp cleanup_run_events(run_id) do
    SQL.query!(Repo, "delete from run_event_payload_refs where run_id = ?", [run_id])
    SQL.query!(Repo, "delete from run_events where run_id = ?", [run_id])
    SQL.query!(Repo, "delete from run_event_sequences where run_id = ?", [run_id])
  end

  defp insert_legacy_run_event!(run_id, body_json) do
    event_id = "evt_" <> Ecto.UUID.generate()

    SQL.query!(
      Repo,
      """
      insert into run_events (
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?)
      """,
      [event_id, run_id, 1, "LegacyInlineEvent", body_json, now()]
    )

    event_id
  end

  defp force_old_mtime(path) do
    old_time = :calendar.system_time_to_universal_time(System.system_time(:second) - 600, :second)

    File.touch(path, old_time) == :ok
  end

  defp install_payload_prepare_hook(parent) do
    original_hooks = Application.get_env(:vilano_kernel, :storage_test_hooks)

    Application.put_env(:vilano_kernel, :storage_test_hooks, %{
      event_payload_prepared: fn payload ->
        send(parent, {:event_payload_prepared, payload})
      end
    })

    fn ->
      case original_hooks do
        nil -> Application.delete_env(:vilano_kernel, :storage_test_hooks)
        hooks -> Application.put_env(:vilano_kernel, :storage_test_hooks, hooks)
      end
    end
  end

  defp assert_prepared_payloads_outside_transaction_at_least(count) do
    payloads = drain_prepared_payloads([])

    assert Enum.count(payloads, &(Map.get(&1, :in_transaction?) == false)) >= count
    refute Enum.any?(payloads, &Map.get(&1, :in_transaction?))
  end

  defp drain_prepared_payloads(payloads) do
    receive do
      {:event_payload_prepared, payload} -> drain_prepared_payloads([payload | payloads])
    after
      100 -> Enum.reverse(payloads)
    end
  end

  defp payload_ref_for_body_json(body_json) do
    sha256 = sha256_hex(body_json)

    %{
      @ref_marker => 1,
      "sha256" => sha256,
      "bytes" => byte_size(body_json),
      "path" => "event-payloads/#{String.slice(sha256, 0, 2)}/#{sha256}.json"
    }
  end

  defp write_payload_file!(root, ref, body_json) do
    path = Path.join(root, ref["path"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, body_json)
    path
  end

  defp insert_project_runtime!(project_name, run_id, path) do
    now = now()

    SQL.query!(
      Repo,
      """
      insert into projects (
        name,
        path,
        snapshot_path,
        workflows_json,
        services_json
      ) values (?, ?, ?, ?, ?)
      """,
      [project_name, path, path, "[]", "[]"]
    )

    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        input_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      """,
      [run_id, project_name, "workflow", "workflow", "completed", "{}", now, now]
    )
  end

  defp insert_workflow_run!(project_name, run_id, timestamp) do
    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        input_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      """,
      [run_id, project_name, "workflow", "workflow", "completed", "{}", timestamp, timestamp]
    )
  end

  defp insert_service_run!(project_name, run_id, timestamp) do
    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        status,
        input_json,
        created_at,
        updated_at
      ) values (?, ?, 'service', 'service', 'running', '{}', ?, ?)
      """,
      [run_id, project_name, timestamp, timestamp]
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
      [run_id, "service-" <> run_id, timestamp, timestamp]
    )
  end

  defp run_exists?(run_id) do
    Repo
    |> SQL.query!("select count(*) from runs where id = ?", [run_id])
    |> first_integer() == 1
  end

  defp service_envelope_exists?(envelope_id) do
    Repo
    |> SQL.query!("select count(*) from service_envelopes where id = ?", [envelope_id])
    |> first_integer() == 1
  end

  defp cleanup_project_runtime(project_name) do
    SQL.query!(
      Repo,
      """
      delete from run_waits
      where run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )

    SQL.query!(
      Repo,
      """
      delete from run_children
      where parent_run_id in (select id from runs where project_name = ?)
        or child_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    SQL.query!(
      Repo,
      """
      delete from run_supervision_restarts
      where group_id in (
        select id
        from run_supervision_groups
        where owner_run_id in (select id from runs where project_name = ?)
      )
      """,
      [project_name]
    )

    SQL.query!(
      Repo,
      """
      delete from run_supervision_members
      where group_id in (
        select id
        from run_supervision_groups
        where owner_run_id in (select id from runs where project_name = ?)
      )
      """,
      [project_name]
    )

    SQL.query!(
      Repo,
      """
      delete from run_supervision_groups
      where owner_run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )

    SQL.query!(
      Repo,
      "delete from run_event_payload_refs where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    SQL.query!(
      Repo,
      "delete from run_events where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    SQL.query!(
      Repo,
      "delete from run_event_sequences where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    SQL.query!(Repo, "delete from runs where project_name = ?", [project_name])
    SQL.query!(Repo, "delete from projects where name = ?", [project_name])
  end

  defp large_body do
    %{
      "message" => "large",
      "nonce" => Ecto.UUID.generate(),
      "payload" => String.duplicate("x", 512),
      "nested" => %{"ok" => true}
    }
  end

  defp valid_ref_shaped_body do
    sha256 = String.duplicate("a", 64)

    %{
      @ref_marker => 1,
      "sha256" => sha256,
      "bytes" => 0,
      "path" => "event-payloads/aa/#{sha256}.json"
    }
  end

  defp run_id, do: "run_" <> Ecto.UUID.generate()

  defp project_name, do: "project-" <> Ecto.UUID.generate()

  defp workflow_project(project_name, path) do
    %{
      "name" => project_name,
      "path" => path,
      "snapshotPath" => path,
      "definitions" => %{"workflows" => [workflow_definition()], "services" => []}
    }
  end

  defp workflow_definition do
    %{
      "name" => "workflow",
      "file" => "src/definitions.ts",
      "exportName" => "workflow",
      "runtimeKind" => "javascript",
      "sourceLanguage" => "typescript"
    }
  end

  defp now do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp old_iso8601 do
    DateTime.utc_now()
    |> DateTime.add(-600, :second)
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp activate_run_for_lease!(run_id, lease_id) do
    now = now()
    lease_expires_at = DateTime.utc_now() |> DateTime.add(60, :second) |> DateTime.to_iso8601()

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'running',
        lease_id = ?,
        lease_auth_token = ?,
        lease_worker_id = ?,
        lease_expires_at = ?,
        updated_at = ?
      where id = ?
      """,
      [lease_id, "token", "worker", lease_expires_at, now, run_id]
    )
  end

  defp sha256_hex(value) do
    :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)
  end
end
