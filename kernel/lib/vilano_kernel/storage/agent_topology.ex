defmodule VilanoKernel.Storage.AgentTopology do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{AgentKernel, Infrastructure, RunControl, ServiceSupport, Support}

  import Support
  import ServiceSupport

  def lookup_singleton_service(lease_id, role, key_input) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        owner_run ->
          case find_singleton_service_definition(project_definitions_for_run(owner_run), role) do
            nil ->
              nil

            definition ->
              service_run =
                owner_run["project"]
                |> list_service_runs_by_definition(Map.fetch!(definition, "name"))
                |> Enum.find(&(&1["keyInput"] == (key_input || %{})))

              case service_run do
                nil ->
                  nil

                resolved ->
                  RunControl.ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
                  record_service_ref!(owner_run["id"], resolved["id"], now)
                  RunControl.ensure_fenced_run_ownership!(owner_run["id"], lease_id, now)
                  resolved
              end
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def resolve_topic_publish(lease_id, topic, op_key, payload) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        caller_run ->
          case AgentKernel.get_run_topic_publish(caller_run["id"], op_key) do
            nil ->
              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
              publish_id = "pub_" <> Ecto.UUID.generate()

              subscriptions =
                AgentKernel.list_topic_subscription_targets(caller_run["project"], topic)

              {enqueued_count, rejected_count} =
                Enum.reduce(subscriptions, {0, 0}, fn subscription, {enqueued, rejected} ->
                  service_run = service_run_from_row(subscription, subscription)

                  delivery_payload = %{
                    "topic" => topic,
                    "payload" => payload,
                    "publishId" => publish_id,
                    "publisherRunId" => caller_run["id"],
                    "publishedAt" => now
                  }

                  case maybe_insert_service_envelope(
                         service_run,
                         "signal",
                         subscription["signal_name"],
                         delivery_payload,
                         nil,
                         caller_run["id"],
                         now
                       ) do
                    {:ok, _envelope_id} -> {enqueued + 1, rejected}
                    {:error, _error} -> {enqueued, rejected + 1}
                  end
                end)

              matched_count = length(subscriptions)

              SQL.query!(
                Repo,
                """
                insert into run_topic_publishes (
                  caller_run_id,
                  op_key,
                  publish_id,
                  topic,
                  payload_json,
                  matched_count,
                  enqueued_count,
                  rejected_count,
                  created_at,
                  updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                  caller_run["id"],
                  op_key,
                  publish_id,
                  topic,
                  maybe_encode_json(payload),
                  matched_count,
                  enqueued_count,
                  rejected_count,
                  now,
                  now
                ]
              )

              append_event!(
                caller_run["id"],
                "TopicPublished",
                %{
                  "key" => op_key,
                  "publishId" => publish_id,
                  "topic" => topic,
                  "matched" => matched_count,
                  "enqueued" => enqueued_count,
                  "rejected" => rejected_count
                },
                now
              )

              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)

              AgentKernel.topic_publish_from_row(
                AgentKernel.get_run_topic_publish(caller_run["id"], op_key)
              )

            publish ->
              AgentKernel.topic_publish_from_row(publish)
          end
      end
    end)
    |> unwrap_transaction_result()
  end

  def subscribe_service_topic(lease_id, topic, signal_name) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with service_run when not is_nil(service_run) <- RunControl.get_fenced_run_by_lease(lease_id, now),
           "service" <- service_run["definitionKind"] do
        RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
        existing = AgentKernel.get_topic_subscription(topic, service_run["id"], signal_name)

        _changes =
          write_changes!(
            """
            insert into topic_subscriptions (
              topic,
              service_run_id,
              signal_name,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?)
            on conflict(topic, service_run_id, signal_name) do update set
              updated_at = excluded.updated_at
            """,
            [topic, service_run["id"], signal_name, now, now]
          )

        if is_nil(existing) do
          append_event!(
            service_run["id"],
            "TopicSubscribed",
            %{"topic" => topic, "signal" => signal_name},
            now
          )
        end

        RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

        AgentKernel.topic_subscription_from_row(
          AgentKernel.get_topic_subscription(topic, service_run["id"], signal_name)
        )
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def unsubscribe_service_topic(lease_id, topic, signal_name) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with service_run when not is_nil(service_run) <- RunControl.get_fenced_run_by_lease(lease_id, now),
           "service" <- service_run["definitionKind"] do
        RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)

        deleted =
          write_changes!(
            """
            delete from topic_subscriptions
            where topic = ? and service_run_id = ? and signal_name = ?
            """,
            [topic, service_run["id"], signal_name]
          )

        if deleted > 0 do
          append_event!(
            service_run["id"],
            "TopicUnsubscribed",
            %{"topic" => topic, "signal" => signal_name},
            now
          )
        end

        RunControl.ensure_fenced_run_ownership!(service_run["id"], lease_id, now)
        %{"ok" => true}
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end
end
