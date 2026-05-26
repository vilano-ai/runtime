defmodule VilanoKernel.Storage.EventPayloads do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  @default_max_bytes 65_536
  @payload_dir "event-payloads"
  @default_gc_grace_ms :timer.minutes(5)
  @ref_marker "__vilano_event_payload_ref__"
  @unavailable_marker "__vilano_event_payload_unavailable__"
  @version 1
  @ref_keys MapSet.new([@ref_marker, "sha256", "bytes", "path"])
  @sha256_hex ~r/\A[0-9a-f]{64}\z/

  def body_for_storage!(body) do
    body_json = Jason.encode!(body)
    max_bytes = max_inline_bytes()

    if externalize_body?(body, body_json, max_bytes) do
      ref = write_payload!(body_json)

      %{
        body_json: Jason.encode!(ref),
        payload_ref: ref
      }
    else
      %{
        body_json: body_json,
        payload_ref: nil
      }
    end
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

  def garbage_collect!(grace_period_ms \\ @default_gc_grace_ms)
      when is_integer(grace_period_ms) and grace_period_ms >= 0 do
    with_write_transaction!(fn ->
      acquire_gc_write_lock!()
      delete_unreferenced_payload_files!(grace_period_ms)
    end)
  end

  defp delete_unreferenced_payload_files!(grace_period_ms) do
    referenced_paths = referenced_payload_paths()
    now_seconds = System.system_time(:second)
    grace_seconds = ceil_div(grace_period_ms, 1_000)
    root = payload_root()

    if File.dir?(root) do
      root
      |> payload_files()
      |> Enum.each(
        &remove_unreferenced_payload_file(&1, referenced_paths, now_seconds, grace_seconds)
      )

      prune_empty_payload_dirs(root)
    end

    :ok
  end

  defp with_write_transaction!(fun) do
    if Repo.in_transaction?() do
      fun.()
    else
      case Repo.transaction(fun, mode: :immediate) do
        {:ok, result} -> result
        {:error, reason} -> raise inspect(reason)
      end
    end
  end

  defp acquire_gc_write_lock! do
    SQL.query!(Repo, "update runtime_metadata set updated_at = updated_at where id = 1", [])
  end

  defp write_payload!(body_json) do
    sha256 = sha256_hex(body_json)
    bytes = byte_size(body_json)
    relative_path = payload_relative_path(sha256)
    absolute_path = payload_absolute_path!(relative_path)

    write_payload_once!(absolute_path, body_json, sha256, bytes)

    %{
      @ref_marker => @version,
      "sha256" => sha256,
      "bytes" => bytes,
      "path" => relative_path
    }
  end

  defp write_payload_once!(path, body_json, sha256, bytes) do
    if File.exists?(path) do
      reuse_or_rewrite_payload_file!(path, body_json, sha256, bytes)
    else
      write_new_payload_file!(path, body_json)
    end

    :ok
  end

  defp reuse_or_rewrite_payload_file!(path, body_json, sha256, bytes) do
    case File.read(path) do
      {:ok, existing_body_json} ->
        if payload_file_matches?(existing_body_json, body_json, sha256, bytes) do
          refresh_payload_file!(path, body_json)
        else
          write_new_payload_file!(path, body_json)
        end

      {:error, :enoent} ->
        write_new_payload_file!(path, body_json)

      {:error, reason} ->
        raise File.Error, reason: reason, action: "read", path: path
    end
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

  defp payload_absolute_path!(relative_path) do
    {:ok, absolute_path} = safe_payload_path(relative_path)
    absolute_path
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

  defp payload_files(root) do
    Path.wildcard(Path.join([root, "*", "*.json"]))
  end

  defp remove_unreferenced_payload_file(
         absolute_path,
         referenced_paths,
         now_seconds,
         grace_seconds
       ) do
    relative_path = Path.relative_to(absolute_path, runtime_home_dir())

    if valid_payload_file_path?(relative_path) and
         not MapSet.member?(referenced_paths, relative_path) and
         old_enough_for_gc?(absolute_path, now_seconds, grace_seconds) do
      remove_file(absolute_path)
    end
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
