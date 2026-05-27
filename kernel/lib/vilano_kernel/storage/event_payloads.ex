defmodule VilanoKernel.Storage.EventPayloads do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.{Infrastructure, Support}

  @default_max_bytes 65_536
  @payload_dir "event-payloads"
  @payload_staging_dir "event-payloads-staging"
  @gc_quarantine_dir "event-payloads-gc"
  @default_gc_grace_ms :timer.minutes(5)
  @pending_marker_min_gc_grace_ms :timer.minutes(5)
  @pending_marker_suffix ".pending"
  @ref_marker "__vilano_event_payload_ref__"
  @unavailable_marker "__vilano_event_payload_unavailable__"
  @version 1
  @ref_keys MapSet.new([@ref_marker, "sha256", "bytes", "path"])
  @sha256_hex ~r/\A[0-9a-f]{64}\z/

  def body_for_storage!(body) do
    storage = prepare_body_for_storage!(body)

    try do
      publish_prepared_payload!(storage)
      storage_result(storage)
    after
      discard_prepared_payload!(storage)
    end
  end

  def prepare_body_for_storage!(body) do
    body_json = Jason.encode!(body)
    max_bytes = max_inline_bytes()

    if externalize_body?(body, body_json, max_bytes) do
      prepared_payload = prepare_payload!(body_json)
      publish_payload!(prepared_payload)
      ref = prepared_payload.ref

      %{
        body_json: Jason.encode!(ref),
        payload_ref: ref,
        prepared_payload: Map.put(prepared_payload, :published?, true)
      }
    else
      %{
        body_json: body_json,
        payload_ref: nil,
        prepared_payload: nil
      }
    end
  end

  def publish_prepared_payload!(%{prepared_payload: nil}), do: :ok
  def publish_prepared_payload!(%{prepared_payload: %{published?: true}}), do: :ok

  def publish_prepared_payload!(%{prepared_payload: prepared_payload}) do
    publish_payload!(prepared_payload)
  end

  def discard_prepared_payload!(%{prepared_payload: nil}), do: :ok

  def discard_prepared_payload!(%{
        prepared_payload: %{staged_path: staged_path, pending_path: pending_path}
      }) do
    remove_file(staged_path)
    remove_file(pending_path)
  end

  def body_json_for_storage!(body) do
    body_for_storage!(body).body_json
  end

  def insert_payload_ref!(_event_id, _run_id, nil, _created_at), do: :ok

  def insert_payload_ref!(event_id, run_id, %{} = ref, created_at) do
    SQL.query!(
      Repo,
      """
      insert into run_event_payload_refs (
        event_id,
        run_id,
        payload_path,
        sha256,
        bytes,
        created_at
      ) values (?, ?, ?, ?, ?, ?)
      """,
      [event_id, run_id, ref["path"], ref["sha256"], ref["bytes"], created_at]
    )

    :ok
  end

  def hydrate_body(%{} = body) do
    case payload_ref(body) do
      {:ok, ref} -> read_payload(ref)
      :error -> body
    end
  end

  def hydrate_body(body), do: body

  defp externalize_body?(body, body_json, max_bytes) do
    byte_size(body_json) > max_bytes or payload_ref?(body)
  end

  defp payload_ref?(%{} = body), do: match?({:ok, _ref}, payload_ref(body))
  defp payload_ref?(_body), do: false

  defp storage_result(storage) do
    %{
      body_json: storage.body_json,
      payload_ref: storage.payload_ref
    }
  end

  def garbage_collect!(grace_period_ms \\ @default_gc_grace_ms)
      when is_integer(grace_period_ms) and grace_period_ms >= 0 do
    candidates = payload_gc_candidates(grace_period_ms)
    stale_canonical_temp_paths = canonical_payload_temp_gc_candidates(grace_period_ms)
    stale_staged_payload_paths = staged_payload_gc_candidates(grace_period_ms)
    stale_pending_marker_paths = pending_payload_marker_gc_candidates(grace_period_ms)

    quarantine_candidates =
      case Infrastructure.transaction_with_busy_retry(
             fn ->
               acquire_gc_write_lock!()
               unreferenced_payload_gc_candidates!(candidates)
             end,
             :admin_control
           ) do
        {:ok, candidates} -> candidates
        {:error, reason} -> raise inspect(reason)
      end

    quarantined_paths =
      quarantine_candidates
      |> Enum.reduce([], fn candidate, quarantined_paths ->
        case quarantine_unreferenced_payload_file(candidate, grace_period_ms) do
          {:ok, quarantined_path} -> [quarantined_path | quarantined_paths]
          :skip -> quarantined_paths
        end
      end)

    Enum.each(quarantined_paths, &remove_file/1)
    remove_stale_payload_temp_files(stale_canonical_temp_paths, grace_period_ms)
    remove_stale_staged_payload_files(stale_staged_payload_paths, grace_period_ms)
    remove_stale_pending_payload_markers(stale_pending_marker_paths, grace_period_ms)
    remove_quarantined_payload_files()
    Enum.each(payload_roots(), &prune_empty_payload_dirs/1)
    prune_empty_payload_dirs(gc_quarantine_root())

    :ok
  end

  defp payload_gc_candidates(grace_period_ms) do
    now_seconds = System.system_time(:second)
    grace_seconds = ceil_div(grace_period_ms, 1_000)

    payload_root_specs()
    |> Enum.flat_map(fn {root, base_dir} ->
      if File.dir?(root) do
        root
        |> payload_files()
        |> Enum.reduce([], fn absolute_path, candidates ->
          relative_path = Path.relative_to(absolute_path, base_dir)

          if valid_payload_file_path?(relative_path) and
               old_enough_for_gc?(absolute_path, now_seconds, grace_seconds) do
            [%{absolute_path: absolute_path, relative_path: relative_path} | candidates]
          else
            candidates
          end
        end)
      else
        []
      end
    end)
  end

  defp staged_payload_gc_candidates(grace_period_ms) do
    root = payload_staging_root()

    if File.dir?(root) do
      now_seconds = System.system_time(:second)
      grace_seconds = ceil_div(grace_period_ms, 1_000)

      root
      |> staged_payload_files()
      |> Enum.filter(&old_enough_for_gc?(&1, now_seconds, grace_seconds))
    else
      []
    end
  end

  defp pending_payload_marker_gc_candidates(grace_period_ms) do
    root = payload_staging_root()

    if File.dir?(root) do
      now_seconds = System.system_time(:second)
      grace_seconds = pending_marker_gc_grace_seconds(grace_period_ms)

      root
      |> pending_payload_marker_files()
      |> Enum.filter(&old_enough_for_gc?(&1, now_seconds, grace_seconds))
    else
      []
    end
  end

  defp canonical_payload_temp_gc_candidates(grace_period_ms) do
    root = payload_root()

    if File.dir?(root) do
      now_seconds = System.system_time(:second)
      grace_seconds = ceil_div(grace_period_ms, 1_000)

      root
      |> canonical_payload_temp_files()
      |> Enum.reduce([], fn absolute_path, candidates ->
        relative_path = Path.relative_to(absolute_path, runtime_home_dir())

        if valid_payload_temp_file_path?(relative_path) and
             old_enough_for_gc?(absolute_path, now_seconds, grace_seconds) do
          [absolute_path | candidates]
        else
          candidates
        end
      end)
    else
      []
    end
  end

  defp remove_stale_payload_temp_files(paths, grace_period_ms) do
    now_seconds = System.system_time(:second)
    grace_seconds = ceil_div(grace_period_ms, 1_000)

    Enum.each(paths, fn path ->
      if old_enough_for_gc?(path, now_seconds, grace_seconds) do
        remove_file(path)
      end
    end)
  end

  defp remove_stale_staged_payload_files(paths, grace_period_ms) do
    now_seconds = System.system_time(:second)
    grace_seconds = ceil_div(grace_period_ms, 1_000)

    Enum.each(paths, fn path ->
      if old_enough_for_gc?(path, now_seconds, grace_seconds) do
        remove_file(path)
      end
    end)
  end

  defp remove_stale_pending_payload_markers(paths, grace_period_ms) do
    now_seconds = System.system_time(:second)
    grace_seconds = pending_marker_gc_grace_seconds(grace_period_ms)

    Enum.each(paths, fn path ->
      if old_enough_for_gc?(path, now_seconds, grace_seconds) do
        remove_file(path)
      end
    end)
  end

  defp unreferenced_payload_gc_candidates!(candidates) do
    referenced_paths = referenced_payload_paths()

    Enum.reject(candidates, fn candidate ->
      MapSet.member?(referenced_paths, candidate.relative_path)
    end)
  end

  defp quarantine_unreferenced_payload_file(candidate, grace_period_ms) do
    pending_sha256s = pending_payload_sha256s()
    now_seconds = System.system_time(:second)
    grace_seconds = ceil_div(grace_period_ms, 1_000)

    if not referenced_payload_path?(candidate.relative_path) and
         not pending_payload_file?(candidate.relative_path, pending_sha256s) and
         old_enough_for_gc?(candidate.absolute_path, now_seconds, grace_seconds) do
      quarantine_payload_file(candidate)
    else
      :skip
    end
  end

  defp acquire_gc_write_lock! do
    SQL.query!(Repo, "update runtime_metadata set updated_at = updated_at where id = 1", [])
  end

  defp prepare_payload!(body_json) do
    sha256 = sha256_hex(body_json)
    bytes = byte_size(body_json)
    relative_path = payload_relative_path(sha256)
    absolute_path = payload_absolute_path!(relative_path)
    staged_path = staged_payload_path!(sha256)
    pending_path = pending_payload_marker_path!(sha256)

    Support.run_storage_test_hook(:event_payload_prepared, %{
      bytes: bytes,
      in_transaction?: Repo.in_transaction?()
    })

    write_staged_payload!(staged_path, body_json)

    ref = %{
      @ref_marker => @version,
      "sha256" => sha256,
      "bytes" => bytes,
      "path" => relative_path
    }

    %{
      ref: ref,
      sha256: sha256,
      bytes: bytes,
      body_json: body_json,
      absolute_path: absolute_path,
      staged_path: staged_path,
      pending_path: pending_path
    }
  end

  defp publish_payload!(prepared_payload) do
    try do
      write_pending_payload_marker!(prepared_payload.pending_path, prepared_payload.ref["path"])

      if File.exists?(prepared_payload.absolute_path) do
        reuse_or_publish_payload_file!(prepared_payload)
      else
        publish_new_payload_file!(prepared_payload)
      end
    after
      remove_file(prepared_payload.staged_path)
    end
  end

  defp reuse_or_publish_payload_file!(
         %{absolute_path: path, body_json: body_json} = prepared_payload
       ) do
    case File.read(path) do
      {:ok, existing_body_json} ->
        if payload_file_matches?(
             existing_body_json,
             body_json,
             prepared_payload.sha256,
             prepared_payload.bytes
           ) do
          refresh_payload_file!(path, body_json)
        else
          publish_new_payload_file!(prepared_payload)
        end

      {:error, :enoent} ->
        publish_new_payload_file!(prepared_payload)

      {:error, reason} ->
        raise File.Error, reason: reason, action: "read", path: path
    end
  end

  defp publish_new_payload_file!(%{
         absolute_path: path,
         staged_path: staged_path,
         body_json: body_json
       }) do
    File.mkdir_p!(Path.dirname(path))

    case File.rename(staged_path, path) do
      :ok ->
        File.chmod!(path, 0o600)

      {:error, _reason} ->
        write_new_payload_file!(path, body_json)
    end
  end

  defp write_staged_payload!(path, body_json) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, body_json)
    File.chmod!(path, 0o600)
  end

  defp write_pending_payload_marker!(path, relative_path) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, relative_path)
    File.chmod!(path, 0o600)
  end

  defp payload_file_matches?(existing_body_json, body_json, sha256, bytes) do
    byte_size(existing_body_json) == bytes and
      sha256_hex(existing_body_json) == sha256 and
      existing_body_json == body_json
  end

  defp refresh_payload_file!(path, body_json) do
    case :file.change_time(String.to_charlist(path), :calendar.local_time()) do
      :ok ->
        chmod_existing_payload_file!(path, body_json)

      {:error, :enoent} ->
        write_new_payload_file!(path, body_json)

      {:error, reason} ->
        raise File.Error, reason: reason, action: "touch", path: path
    end
  end

  defp chmod_existing_payload_file!(path, body_json) do
    case File.chmod(path, 0o600) do
      :ok ->
        :ok

      {:error, :enoent} ->
        write_new_payload_file!(path, body_json)

      {:error, reason} ->
        raise File.Error, reason: reason, action: "chmod", path: path
    end
  end

  defp write_new_payload_file!(path, body_json) do
    File.mkdir_p!(Path.dirname(path))

    tmp_path =
      Path.join(
        Path.dirname(path),
        ".#{Path.basename(path)}.#{System.unique_integer([:positive])}.tmp"
      )

    File.write!(tmp_path, body_json)

    try do
      File.rename!(tmp_path, path)
      File.chmod!(path, 0o600)
    after
      if File.exists?(tmp_path) do
        File.rm(tmp_path)
      end
    end
  end

  defp read_payload(ref) do
    case read_payload_from_roots(ref) do
      {:ok, body} -> body
      {:error, reason} -> unavailable_body(ref, reason)
    end
  end

  defp read_payload_from_roots(ref) do
    ref["path"]
    |> payload_read_paths()
    |> Enum.reduce_while({:error, "missing"}, fn absolute_path, fallback_error ->
      case read_payload_from_path(absolute_path, ref) do
        {:ok, body} ->
          {:halt, {:ok, body}}

        {:error, "missing"} ->
          {:cont, fallback_error}

        {:error, reason} ->
          {:cont, first_non_missing_error(fallback_error, reason)}
      end
    end)
  end

  defp read_payload_from_path(absolute_path, ref) do
    with {:ok, body_json} <- read_payload_file(absolute_path),
         :ok <- verify_payload_bytes(body_json, ref["bytes"]),
         :ok <- verify_payload_sha256(body_json, ref["sha256"]),
         {:ok, body} <- decode_payload_json(body_json) do
      {:ok, body}
    end
  end

  defp first_non_missing_error({:error, "missing"}, reason), do: {:error, reason}
  defp first_non_missing_error(error, _reason), do: error

  defp payload_ref(ref) do
    cond do
      Map.get(ref, @ref_marker) != @version ->
        :error

      MapSet.new(Map.keys(ref)) != @ref_keys ->
        :error

      not valid_sha256?(ref["sha256"]) ->
        :error

      not is_integer(ref["bytes"]) or ref["bytes"] < 0 ->
        :error

      not valid_payload_ref_path?(ref["path"], ref["sha256"]) ->
        :error

      true ->
        {:ok, ref}
    end
  end

  defp read_payload_file(path) do
    case File.read(path) do
      {:ok, body_json} -> {:ok, body_json}
      {:error, :enoent} -> {:error, "missing"}
      {:error, reason} -> {:error, "read_failed:#{reason}"}
    end
  end

  defp verify_payload_bytes(body_json, expected_bytes) do
    if byte_size(body_json) == expected_bytes do
      :ok
    else
      {:error, "byte_size_mismatch"}
    end
  end

  defp verify_payload_sha256(body_json, expected_sha256) do
    if sha256_hex(body_json) == expected_sha256 do
      :ok
    else
      {:error, "sha256_mismatch"}
    end
  end

  defp decode_payload_json(body_json) do
    case Jason.decode(body_json) do
      {:ok, body} -> {:ok, body}
      {:error, _reason} -> {:error, "invalid_json"}
    end
  end

  defp unavailable_body(ref, reason) do
    %{
      @unavailable_marker => @version,
      "reason" => reason,
      "sha256" => Map.get(ref, "sha256"),
      "bytes" => Map.get(ref, "bytes"),
      "path" => Map.get(ref, "path")
    }
  end

  defp payload_relative_path(sha256) do
    Path.join([@payload_dir, String.slice(sha256, 0, 2), sha256 <> ".json"])
  end

  defp valid_payload_ref_path?(path, sha256) when is_binary(path) do
    path == payload_relative_path(sha256) and match?({:ok, _path}, safe_payload_path(path))
  end

  defp valid_payload_ref_path?(_path, _sha256), do: false

  defp valid_payload_file_path?(relative_path) do
    case Path.split(relative_path) do
      [@payload_dir, prefix, filename] ->
        with <<sha256::binary-size(64), ".json">> <- filename,
             true <- valid_sha256?(sha256),
             true <- prefix == String.slice(sha256, 0, 2) do
          true
        else
          _ -> false
        end

      _ ->
        false
    end
  end

  defp payload_sha256_from_relative_path(relative_path) do
    case Path.split(relative_path) do
      [@payload_dir, prefix, filename] ->
        with <<sha256::binary-size(64), ".json">> <- filename,
             true <- valid_sha256?(sha256),
             true <- prefix == String.slice(sha256, 0, 2) do
          sha256
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp valid_payload_temp_file_path?(relative_path) do
    case Path.split(relative_path) do
      [@payload_dir, prefix, "." <> filename] ->
        with <<sha256::binary-size(64), ".json.", tmp_id::binary>> <- filename,
             true <- valid_sha256?(sha256),
             true <- prefix == String.slice(sha256, 0, 2),
             true <- String.ends_with?(tmp_id, ".tmp"),
             true <- tmp_id != ".tmp" do
          true
        else
          _ -> false
        end

      _ ->
        false
    end
  end

  defp payload_absolute_path!(relative_path) do
    {:ok, absolute_path} = safe_payload_path(relative_path)
    absolute_path
  end

  defp staged_payload_path!(sha256) do
    Path.join([
      payload_staging_root(),
      String.slice(sha256, 0, 2),
      "#{sha256}.#{System.unique_integer([:positive])}.tmp"
    ])
  end

  defp pending_payload_marker_path!(sha256) do
    Path.join([
      payload_staging_root(),
      String.slice(sha256, 0, 2),
      "#{sha256}.#{System.unique_integer([:positive])}#{@pending_marker_suffix}"
    ])
  end

  defp payload_read_paths(relative_path) do
    [
      safe_payload_path(relative_path),
      safe_legacy_payload_path(relative_path)
    ]
    |> Enum.reduce([], fn
      {:ok, absolute_path}, paths -> [absolute_path | paths]
      {:error, _reason}, paths -> paths
    end)
    |> Enum.reverse()
    |> Enum.uniq()
  end

  defp payload_root do
    Path.join(runtime_home_dir(), @payload_dir)
  end

  defp payload_roots do
    payload_root_specs()
    |> Enum.map(fn {root, _base_dir} -> root end)
    |> Enum.uniq()
  end

  defp payload_root_specs do
    [
      {Path.join(runtime_home_dir(), @payload_dir), runtime_home_dir()},
      {Path.join(execution_home_dir(), @payload_dir), execution_home_dir()}
    ]
    |> Enum.uniq()
  end

  defp payload_staging_root do
    Path.join(runtime_home_dir(), @payload_staging_dir)
  end

  defp gc_quarantine_root do
    Path.join(runtime_home_dir(), @gc_quarantine_dir)
  end

  defp safe_payload_path(relative_path) do
    safe_payload_path(relative_path, runtime_home_dir())
  end

  defp safe_legacy_payload_path(relative_path) do
    safe_payload_path(relative_path, execution_home_dir())
  end

  defp safe_payload_path(relative_path, root) when is_binary(relative_path) and is_binary(root) do
    expanded_root = Path.expand(root)
    expanded_path = Path.expand(Path.join(expanded_root, relative_path))

    if relative_path?(relative_path) and under_root?(expanded_path, expanded_root) do
      {:ok, expanded_path}
    else
      {:error, "invalid_path"}
    end
  end

  defp safe_payload_path(_relative_path, _root), do: {:error, "invalid_path"}

  defp relative_path?(path) do
    Path.type(path) == :relative and ".." not in Path.split(path)
  end

  defp under_root?(path, root) do
    path == root or String.starts_with?(path, root <> "/")
  end

  defp sha256_hex(value) do
    :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)
  end

  defp valid_sha256?(value) when is_binary(value), do: Regex.match?(@sha256_hex, value)
  defp valid_sha256?(_value), do: false

  defp referenced_payload_paths do
    Repo
    |> SQL.query!("select distinct payload_path from run_event_payload_refs", [])
    |> Map.fetch!(:rows)
    |> Enum.reduce(MapSet.new(), fn [payload_path], acc ->
      MapSet.put(acc, payload_path)
    end)
  end

  defp referenced_payload_path?(relative_path) do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          "select 1 from run_event_payload_refs where payload_path = ? limit 1",
          [relative_path]
        )
        |> Map.fetch!(:rows)
        |> Enum.any?()
      end,
      :public_read
    )
  end

  defp payload_files(root) do
    Path.wildcard(Path.join([root, "*", "*.json"]))
  end

  defp staged_payload_files(root) do
    Path.wildcard(Path.join([root, "*", "*.tmp"]))
  end

  defp pending_payload_marker_files(root) do
    Path.wildcard(Path.join([root, "*", "*#{@pending_marker_suffix}"]))
  end

  defp canonical_payload_temp_files(root) do
    Path.wildcard(Path.join([root, "*", ".*.json.*.tmp"]), match_dot: true)
  end

  defp pending_payload_sha256s do
    payload_staging_root()
    |> pending_payload_marker_files()
    |> Enum.reduce(MapSet.new(), fn path, acc ->
      case pending_payload_sha256(path) do
        nil -> acc
        sha256 -> MapSet.put(acc, sha256)
      end
    end)
  end

  defp pending_payload_file?(relative_path, pending_sha256s) do
    case payload_sha256_from_relative_path(relative_path) do
      nil -> false
      sha256 -> MapSet.member?(pending_sha256s, sha256)
    end
  end

  defp pending_payload_sha256(path) do
    case path |> Path.basename() |> String.split(".", parts: 2) do
      [sha256, _suffix] ->
        if valid_sha256?(sha256), do: sha256, else: nil

      _ ->
        nil
    end
  end

  defp quarantine_payload_file(%{
         absolute_path: absolute_path,
         relative_path: relative_path
       }) do
    case Path.split(relative_path) do
      [@payload_dir, prefix, filename] ->
        quarantine_path =
          Path.join([
            gc_quarantine_root(),
            prefix,
            "#{filename}.#{System.unique_integer([:positive])}.gc"
          ])

        File.mkdir_p!(Path.dirname(quarantine_path))

        case File.rename(absolute_path, quarantine_path) do
          :ok -> {:ok, quarantine_path}
          {:error, _reason} -> :skip
        end

      _ ->
        :skip
    end
  end

  defp remove_quarantined_payload_files do
    gc_quarantine_root()
    |> Path.join("*")
    |> Path.join("*.gc")
    |> Path.wildcard()
    |> Enum.each(&remove_file/1)
  end

  defp old_enough_for_gc?(path, now_seconds, grace_seconds) do
    case File.stat(path, time: :posix) do
      {:ok, %{mtime: mtime_seconds}} when is_integer(mtime_seconds) ->
        now_seconds - mtime_seconds >= grace_seconds

      _ ->
        false
    end
  end

  defp ceil_div(value, divisor) do
    div(value + divisor - 1, divisor)
  end

  defp pending_marker_gc_grace_seconds(grace_period_ms) do
    grace_period_ms
    |> max(@pending_marker_min_gc_grace_ms)
    |> ceil_div(1_000)
  end

  defp remove_file(path) do
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      {:error, _reason} -> :ok
    end
  end

  defp prune_empty_payload_dirs(root) do
    root
    |> Path.join("*")
    |> Path.wildcard()
    |> Enum.filter(&File.dir?/1)
    |> Enum.each(&File.rmdir/1)

    File.rmdir(root)
  end

  defp max_inline_bytes do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    case runtime.event_payload_max_bytes do
      value when is_integer(value) and value >= 0 -> value
      _ -> @default_max_bytes
    end
  end

  defp runtime_home_dir do
    Application.fetch_env!(:vilano_kernel, :runtime).home_dir
  end

  defp execution_home_dir do
    Application.fetch_env!(:vilano_kernel, :runtime).execution_home_dir
  end
end
