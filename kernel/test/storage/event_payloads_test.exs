defmodule VilanoKernel.Storage.EventPayloadsTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.EventPayloads
  alias VilanoKernel.Storage.Migrations.CreateRunEventPayloadRefs
  alias VilanoKernel.Storage.ReadModels
  alias VilanoKernel.Storage.Support

  @ref_marker "__vilano_event_payload_ref__"
  @unavailable_marker "__vilano_event_payload_unavailable__"

  setup do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    execution_home = Path.join(System.tmp_dir!(), "vilano-event-payloads-#{Ecto.UUID.generate()}")

    Application.put_env(:vilano_kernel, :runtime, %{
      runtime
      | execution_home_dir: execution_home,
        event_payload_max_bytes: 128
    })

    on_exit(fn ->
      Application.put_env(:vilano_kernel, :runtime, runtime)
      File.rm_rf(execution_home)
    end)

    {:ok, execution_home: execution_home}
  end

  test "small events remain inline", %{execution_home: execution_home} do
    run_id = run_id()
    body = %{"message" => "small"}

    try do
      Support.append_event!(run_id, "SmallEvent", body, now())

      [row] = event_rows(run_id)
      stored_body = Jason.decode!(row["body_json"])

      assert stored_body == body
      refute Map.has_key?(stored_body, @ref_marker)
      assert payload_ref_rows(run_id) == []
      refute File.exists?(Path.join(execution_home, "event-payloads"))

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
    after
      cleanup_run_events(run_id)
    end
  end

  test "large events are externalized and hydrated", %{execution_home: execution_home} do
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

      payload_path = Path.join(execution_home, ref["path"])
      assert File.exists?(payload_path)
      assert File.read!(payload_path) == body_json

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
    after
      cleanup_run_events(run_id)
    end
  end

  test "zero payload cap externalizes events", %{execution_home: execution_home} do
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
      assert File.read!(Path.join(execution_home, ref["path"])) == body_json

      assert [event] = ReadModels.list_run_events(run_id)
      assert event["body"] == body
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
    execution_home: execution_home
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
      assert File.read!(Path.join(execution_home, ref["path"])) == body_json
      assert [_payload_ref] = payload_ref_rows(run_id)

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body]
    after
      cleanup_run_events(run_id)
    end
  end

  test "repeated large event bodies reuse one payload file", %{execution_home: execution_home} do
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

      payload_files = Path.wildcard(Path.join([execution_home, "event-payloads", "*", "*.json"]))
      assert length(payload_files) == 1

      assert ReadModels.list_run_events(run_id) |> Enum.map(& &1["body"]) == [body, body]
    after
      cleanup_run_events(run_id)
    end
  end

  test "garbage collection waits for uncommitted payload event appends", %{
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()
    parent = self()

    append_task =
      Task.async(fn ->
        Repo.transaction(fn ->
          Support.append_event!(run_id, "LargeEvent", body, now())

          [ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
          payload_path = Path.join(execution_home, ref["path"])
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
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [ref] = event_rows(run_id) |> Enum.map(&Jason.decode!(&1["body_json"]))
      payload_path = Path.join(execution_home, ref["path"])

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

  test "missing payload returns unavailable marker instead of crashing", %{
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      File.rm!(Path.join(execution_home, ref["path"]))

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
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      payload_path = Path.join(execution_home, ref["path"])
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
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      Support.append_event!(run_id, "LargeEvent", body, now())

      [row] = event_rows(run_id)
      ref = Jason.decode!(row["body_json"])
      payload_path = Path.join(execution_home, ref["path"])

      cleanup_run_events(run_id)

      EventPayloads.garbage_collect!()
      assert File.exists?(payload_path)

      EventPayloads.garbage_collect!(0)
      refute File.exists?(payload_path)
    after
      cleanup_run_events(run_id)
    end
  end

  test "project runtime purge removes only unreferenced payload files", %{
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

      payload_path = Path.join(execution_home, ref_a["path"])
      assert File.exists?(payload_path)

      assert %{"purgedRunCount" => 1} = Storage.purge_project_runtime(project_a)
      assert [] = payload_ref_rows(run_a)
      assert [_] = payload_ref_rows(run_b)

      EventPayloads.garbage_collect!(0)
      assert File.exists?(payload_path)
      assert ReadModels.list_run_events(run_b) |> Enum.map(& &1["body"]) == [body]

      assert %{"purgedRunCount" => 1} = Storage.purge_project_runtime(project_b)
      assert [] = payload_ref_rows(run_b)

      EventPayloads.garbage_collect!(0)
      refute File.exists?(payload_path)
    after
      cleanup_project_runtime(project_a)
      cleanup_project_runtime(project_b)
    end
  end

  test "garbage collection removes orphan payloads with unrelated marker rows present", %{
    execution_home: execution_home
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
      payload_path = Path.join(execution_home, ref["path"])
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
    execution_home: execution_home
  } do
    run_id = run_id()
    body = large_body()

    try do
      storage = EventPayloads.body_for_storage!(body)
      ref = Jason.decode!(storage.body_json)
      insert_legacy_run_event!(run_id, storage.body_json)

      payload_path = Path.join(execution_home, ref["path"])
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
      select id, body_json, created_at
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

  defp cleanup_project_runtime(project_name) do
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

  defp now do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  defp sha256_hex(value) do
    :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)
  end
end
