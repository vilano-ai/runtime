defmodule VilanoKernel.Router.RunHandlers do
  @moduledoc false

  alias VilanoKernel.Storage

  import VilanoKernel.Router.Support

  def create_run(conn) do
    project = fetch_required_string(conn.body_params, "project")
    workflow = fetch_required_string(conn.body_params, "workflow")

    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.find_definition(project_record, "workflow", workflow),
         run <-
           Storage.create_workflow_run!(
             project_record,
             definition,
             Map.get(conn.body_params, "input", %{})
           ) do
      send_json(conn, 200, %{ok: true, run: run})
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown workflow '#{workflow}' in project '#{project}'"
        )
    end
  end

  def list_runs(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case project_name do
      nil ->
        send_json(conn, 200, %{ok: true, project: nil, runs: Storage.list_runs()})

      name ->
        case Storage.get_project(name) do
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{ok: true, project: name, runs: Storage.list_runs(name)})
        end
    end
  end

  def inspect_run(conn, id), do: send_run_inspect(conn, id)

  def replay_run(conn, id), do: send_run_replay(conn, id)

  def cancel_run(conn, id) do
    case Storage.cancel_run(id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{id}")

      result ->
        maybe_kill_managed_worker(result)

        send_json(conn, 200, %{
          ok: true,
          run: result["run"],
          cancelledWaitCount: result["cancelledWaitCount"],
          cancelledChildRunCount: result["cancelledChildRunCount"],
          cancelledServiceAskCount: result["cancelledServiceAskCount"],
          hadActiveLease: result["hadActiveLease"],
          stoppedEnvelopeCount: Map.get(result, "stoppedEnvelopeCount", 0),
          hadInFlightTurn: Map.get(result, "hadInFlightTurn", false)
        })
    end
  end

  def signal_run(conn, id) do
    name = fetch_required_string(conn.body_params, "name")
    payload = Map.get(conn.body_params, "payload")

    case Storage.send_run_signal(id, name, payload) do
      nil -> send_error(conn, 404, "not_found", "Unknown run: #{id}")
      signal -> send_json(conn, 200, %{ok: true, signal: signal})
    end
  end
end
