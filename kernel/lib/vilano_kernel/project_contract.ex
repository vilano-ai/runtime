defmodule VilanoKernel.ProjectContract do
  @moduledoc false

  @project_name ~r/^[A-Za-z0-9][A-Za-z0-9._-]*$/
  @runtime_kinds MapSet.new(["javascript"])
  @source_languages MapSet.new(["typescript", "javascript"])

  def validate(project) when is_map(project) do
    with {:ok, name} <- validate_project_name(Map.get(project, "name")),
         {:ok, path} <- validate_directory(Map.get(project, "path"), "path"),
         {:ok, snapshot_path} <- validate_snapshot_path(Map.get(project, "snapshotPath"), path),
         {:ok, definitions} <- validate_definitions(Map.get(project, "definitions", %{}), snapshot_path) do
      {:ok,
       %{
         "name" => name,
         "path" => path,
         "snapshotPath" => snapshot_path,
         "lastSyncedAt" => Map.get(project, "lastSyncedAt"),
         "definitionsManifestHash" => Map.get(project, "definitionsManifestHash"),
         "definitions" => definitions
       }}
    end
  end

  def validate(_project), do: {:error, "Invalid project payload"}

  defp validate_project_name(name) when is_binary(name) and name != "" do
    if Regex.match?(@project_name, name) do
      {:ok, name}
    else
      {:error, "Project name must match #{inspect(@project_name)}"}
    end
  end

  defp validate_project_name(_name), do: {:error, "Project name must be a non-empty string"}

  defp validate_snapshot_path(nil, project_path), do: {:ok, project_path}
  defp validate_snapshot_path("", project_path), do: {:ok, project_path}
  defp validate_snapshot_path(snapshot_path, _project_path), do: validate_directory(snapshot_path, "snapshotPath")

  defp validate_directory(value, field_name) when is_binary(value) and value != "" do
    expanded = Path.expand(value)

    cond do
      Path.type(expanded) != :absolute ->
        {:error, "#{field_name} must be an absolute path"}

      true ->
        case File.lstat(expanded) do
          {:ok, %{type: :symlink}} ->
            {:error, "#{field_name} must not be a symbolic link"}

          {:ok, %{type: :directory}} ->
            {:ok, expanded}

          {:ok, _stat} ->
            {:error, "#{field_name} must point to a directory"}

          {:error, :enoent} ->
            {:error, "#{field_name} does not exist"}

          {:error, reason} ->
            {:error, "#{field_name} is invalid: #{inspect(reason)}"}
        end
    end
  end

  defp validate_directory(_value, field_name),
    do: {:error, "#{field_name} must be a non-empty string"}

  defp validate_definitions(definitions, snapshot_path) when is_map(definitions) do
    with {:ok, workflows} <- validate_definition_bucket("workflow", Map.get(definitions, "workflows", []), snapshot_path),
         {:ok, services} <- validate_definition_bucket("service", Map.get(definitions, "services", []), snapshot_path) do
      {:ok, %{"workflows" => workflows, "services" => services}}
    end
  end

  defp validate_definitions(_definitions, _snapshot_path),
    do: {:error, "definitions must be an object with workflows and services arrays"}

  defp validate_definition_bucket(kind, records, snapshot_path) when is_list(records) do
    records
    |> Enum.reduce_while({:ok, []}, fn record, {:ok, acc} ->
      case validate_definition_record(kind, record, snapshot_path) do
        {:ok, validated} -> {:cont, {:ok, [validated | acc]}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, validated} -> {:ok, Enum.reverse(validated)}
      error -> error
    end
  end

  defp validate_definition_bucket(kind, _records, _snapshot_path),
    do: {:error, "#{kind} definitions must be an array"}

  defp validate_definition_record(expected_kind, record, snapshot_path)
       when is_map(record) do
    with {:ok, kind} <- validate_enum_field(record, "kind", [expected_kind]),
         {:ok, name} <- validate_required_string(record, "name"),
         {:ok, export_name} <- validate_required_string(record, "exportName"),
         {:ok, runtime_kind} <- validate_supported_string(record, "runtimeKind", @runtime_kinds),
         {:ok, source_language} <- validate_supported_string(record, "sourceLanguage", @source_languages),
         {:ok, file} <- validate_definition_file(record, snapshot_path, name) do
      {:ok,
       %{
         "kind" => kind,
         "name" => name,
         "exportName" => export_name,
         "file" => file,
         "runtimeKind" => runtime_kind,
         "sourceLanguage" => source_language
       }}
    end
  end

  defp validate_definition_record(expected_kind, _record, _snapshot_path),
    do: {:error, "#{expected_kind} definitions must be objects"}

  defp validate_definition_file(record, snapshot_path, definition_name) do
    with {:ok, file} <- validate_required_string(record, "file"),
         :ok <- ensure_relative_path(file, definition_name),
         {:ok, resolved_path} <- ensure_definition_file(snapshot_path, file, definition_name) do
      {:ok, Path.relative_to(resolved_path, snapshot_path)}
    end
  end

  defp ensure_relative_path(file, definition_name) do
    if Path.type(file) == :absolute do
      {:error, "Definition '#{definition_name}' must use a relative file path"}
    else
      :ok
    end
  end

  defp ensure_definition_file(snapshot_path, file, definition_name) do
    resolved = Path.expand(file, snapshot_path)
    relative = Path.relative_to(resolved, snapshot_path)

    cond do
      relative == "" or relative == "." or relative == ".." or Path.type(relative) == :absolute or
          String.starts_with?(relative, "../") ->
        {:error, "Definition '#{definition_name}' file must stay within the snapshot root"}

      true ->
        case File.lstat(resolved) do
          {:ok, %{type: :symlink}} ->
            {:error, "Definition '#{definition_name}' file must not be a symbolic link"}

          {:ok, %{type: :regular}} ->
            with :ok <- ensure_no_symlink_components(resolved, snapshot_path, definition_name) do
              {:ok, resolved}
            end

          {:ok, _stat} ->
            {:error, "Definition '#{definition_name}' file must point to a regular file"}

          {:error, :enoent} ->
            {:error, "Definition '#{definition_name}' file does not exist"}

          {:error, reason} ->
            {:error, "Definition '#{definition_name}' file is invalid: #{inspect(reason)}"}
        end
    end
  end

  defp ensure_no_symlink_components(path, root, definition_name) do
    path
    |> Path.relative_to(root)
    |> String.split("/", trim: true)
    |> Enum.reduce_while(root, fn segment, current ->
      next_path = Path.join(current, segment)

      case File.lstat(next_path) do
        {:ok, %{type: :symlink}} ->
          {:halt, {:error, "Definition '#{definition_name}' file must not traverse symbolic links"}}

        {:ok, _stat} ->
          {:cont, next_path}

        {:error, reason} ->
          {:halt, {:error, "Definition '#{definition_name}' file is invalid: #{inspect(reason)}"}}
      end
    end)
    |> case do
      {:error, _reason} = error -> error
      _ -> :ok
    end
  end

  defp validate_required_string(record, key) do
    case Map.get(record, key) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> {:error, "#{key} must be a non-empty string"}
    end
  end

  defp validate_enum_field(record, key, allowed_values) do
    with {:ok, value} <- validate_required_string(record, key) do
      if value in allowed_values do
        {:ok, value}
      else
        {:error, "#{key} must be one of #{Enum.join(allowed_values, ", ")}"}
      end
    end
  end

  defp validate_supported_string(record, key, allowed_values) do
    with {:ok, value} <- validate_required_string(record, key) do
      if MapSet.member?(allowed_values, value) do
        {:ok, value}
      else
        {:error, "#{key} '#{value}' is not supported by this runtime"}
      end
    end
  end
end
