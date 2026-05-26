defmodule VilanoKernel.Storage.Usage do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  def database_summary do
    %{
      "projects" => scalar!("select count(*) from projects"),
      "runs" => scalar!("select count(*) from runs"),
      "runEvents" =>
        count_and_bytes!("select count(*), coalesce(sum(length(body_json)), 0) from run_events"),
      "eventPayloadRefs" =>
        count_and_bytes!("select count(*), coalesce(sum(bytes), 0) from run_event_payload_refs"),
      "serviceStates" =>
        count_and_bytes!(
          "select count(*), coalesce(sum(length(state_json)), 0) from service_runs where state_json is not null"
        ),
      "serviceEnvelopes" =>
        count_and_bytes!(
          "select count(*), coalesce(sum(length(payload_json)), 0) from service_envelopes where payload_json is not null"
        ),
      "runExecs" =>
        count_and_bytes!("""
        select
          count(*),
          coalesce(sum(
            coalesce(length(args_json), 0) +
            coalesce(length(env_json), 0) +
            coalesce(length(artifacts_json), 0) +
            coalesce(length(output_json), 0) +
            coalesce(length(error_json), 0)
          ), 0)
        from run_execs
        """)
    }
  end

  def path_summary(paths) do
    Enum.map(paths, fn {name, path, kind} ->
      path
      |> path_usage()
      |> Map.merge(%{
        "name" => name,
        "path" => path,
        "kind" => kind
      })
    end)
  end

  def path_usage(path) do
    case File.lstat(path, time: :posix) do
      {:ok, stat} ->
        usage_for_stat(path, stat)

      {:error, :enoent} ->
        empty_usage(false)

      {:error, reason} ->
        empty_usage(false) |> Map.put("error", Atom.to_string(reason))
    end
  end

  defp scalar!(query) do
    Repo
    |> SQL.query!(query, [])
    |> SqlSupport.first_integer()
  end

  defp count_and_bytes!(query) do
    case SQL.query!(Repo, query, []) do
      %{rows: [[count, bytes]]} ->
        %{"count" => integer_or_zero(count), "bytes" => integer_or_zero(bytes)}

      _ ->
        %{"count" => 0, "bytes" => 0}
    end
  end

  defp usage_for_stat(path, %{type: :directory}) do
    path
    |> directory_usage()
    |> Map.update!("directories", &(&1 + 1))
    |> Map.put("exists", true)
  end

  defp usage_for_stat(_path, %{type: :regular, size: size}) do
    %{"exists" => true, "bytes" => size, "files" => 1, "directories" => 0}
  end

  defp usage_for_stat(_path, %{type: :symlink, size: size}) do
    %{"exists" => true, "bytes" => size, "files" => 1, "directories" => 0}
  end

  defp usage_for_stat(_path, _stat) do
    %{"exists" => true, "bytes" => 0, "files" => 0, "directories" => 0}
  end

  defp directory_usage(path) do
    case File.ls(path) do
      {:ok, entries} ->
        Enum.reduce(entries, empty_usage(true), fn entry, acc ->
          entry_usage = path_usage(Path.join(path, entry))

          %{
            "exists" => true,
            "bytes" => acc["bytes"] + entry_usage["bytes"],
            "files" => acc["files"] + entry_usage["files"],
            "directories" => acc["directories"] + entry_usage["directories"]
          }
        end)

      {:error, reason} ->
        empty_usage(true) |> Map.put("error", Atom.to_string(reason))
    end
  end

  defp empty_usage(exists) do
    %{"exists" => exists, "bytes" => 0, "files" => 0, "directories" => 0}
  end

  defp integer_or_zero(value) when is_integer(value), do: value
  defp integer_or_zero(_value), do: 0
end
