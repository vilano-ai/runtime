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
    resolve_topic_publish_with_prepared_events_retry(lease_id, topic, op_key, payload, 3)
  end

  defp resolve_topic_publish_with_prepared_events_retry(
         lease_id,
         topic,
         op_key,
         payload,
         attempts_left
       ) do
    now = Infrastructure.now_iso8601()
    prepared_publish = prepare_topic_publish_plan!(lease_id, topic, op_key, payload, now)

    try do
      case resolve_topic_publish_transaction(
             lease_id,
             topic,
             op_key,
             payload,
             now,
             prepared_publish
           ) do
        {:ok, result} ->
          result

        {:error, :stale_cancellation_plan} when attempts_left > 1 ->
          resolve_topic_publish_with_prepared_events_retry(
            lease_id,
            topic,
            op_key,
            payload,
            attempts_left - 1
          )

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_topic_publish_events(prepared_publish)
    end
  end

  defp resolve_topic_publish_transaction(lease_id, topic, op_key, payload, now, prepared_publish) do
    Infrastructure.transaction_with_busy_retry(fn ->
      case RunControl.get_fenced_run_by_lease(lease_id, now) do
        nil ->
          nil

        caller_run ->
          case AgentKernel.get_run_topic_publish(caller_run["id"], op_key) do
            nil ->
              prepared_publish =
                prepared_topic_publish_plan!(prepared_publish, caller_run, topic, op_key, payload)

              RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
              publish_id = prepared_publish.publish_id

              subscriptions =
                AgentKernel.list_topic_subscription_targets(caller_run["project"], topic)

              validate_prepared_topic_deliveries!(prepared_publish, subscriptions)

              {enqueued_count, rejected_count} =
                Enum.reduce(subscriptions, {0, 0}, fn subscription, {enqueued, rejected} ->
                  service_run = service_run_from_row(subscription, subscription)

                  prepared_delivery =
                    prepared_topic_delivery!(
                      prepared_publish,
                      service_run["id"],
                      subscription["signal_name"]
                    )

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
                         now,
                         prepared_delivery.inbound_enqueued_event
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
                  prepared_publish.payload_json,
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
              if is_map(prepared_publish), do: Repo.rollback(:stale_cancellation_plan)

              AgentKernel.topic_publish_from_row(publish)
          end
      end
    end)
  end

  defp prepare_topic_publish_plan!(lease_id, topic, op_key, payload, now) do
    Infrastructure.run_with_busy_retry(
      fn ->
        case RunControl.get_run_by_lease(lease_id) do
          nil ->
            nil

          caller_run ->
            case AgentKernel.get_run_topic_publish(caller_run["id"], op_key) do
              nil ->
                publish_id = "pub_" <> Ecto.UUID.generate()

                subscriptions =
                  AgentKernel.list_topic_subscription_targets(caller_run["project"], topic)

                deliveries =
                  prepare_topic_deliveries!(
                    subscriptions,
                    caller_run,
                    topic,
                    payload,
                    publish_id,
                    now
                  )

                %{
                  caller_run_id: caller_run["id"],
                  caller_run_status: caller_run["status"],
                  topic: topic,
                  op_key: op_key,
                  payload: payload,
                  payload_json: maybe_encode_json(payload),
                  publish_id: publish_id,
                  published_at: now,
                  deliveries: deliveries
                }

              _existing ->
                nil
            end
        end
      end,
      :public_read
    )
  end

  defp discard_prepared_topic_publish_events(nil), do: :ok

  defp discard_prepared_topic_publish_events(%{} = prepared_publish) do
    prepared_publish.deliveries
    |> Enum.each(fn delivery ->
      discard_prepared_service_envelope_enqueue_event(delivery.inbound_enqueued_event)
    end)
  end

  defp prepare_topic_deliveries!(subscriptions, caller_run, topic, payload, publish_id, now) do
    subscriptions
    |> Enum.reduce([], fn subscription, deliveries ->
      service_run = service_run_from_row(subscription, subscription)

      delivery_payload = %{
        "topic" => topic,
        "payload" => payload,
        "publishId" => publish_id,
        "publisherRunId" => caller_run["id"],
        "publishedAt" => now
      }

      delivery =
        try do
          %{
            service_run_id: service_run["id"],
            signal_name: subscription["signal_name"],
            inbound_enqueued_event:
              prepare_service_envelope_enqueue_event(
                service_run,
                "signal",
                subscription["signal_name"],
                delivery_payload,
                nil,
                caller_run["id"]
              )
          }
        rescue
          error ->
            Enum.each(deliveries, fn prepared_delivery ->
              discard_prepared_service_envelope_enqueue_event(
                prepared_delivery.inbound_enqueued_event
              )
            end)

            reraise error, __STACKTRACE__
        end

      [delivery | deliveries]
    end)
    |> Enum.reverse()
  end

  defp prepared_topic_publish_plan!(nil, _caller_run, _topic, _op_key, _payload),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_topic_publish_plan!(prepared_publish, caller_run, topic, op_key, payload)
       when is_map(prepared_publish) do
    if prepared_publish.caller_run_id == caller_run["id"] and
         prepared_publish.caller_run_status == caller_run["status"] and
         prepared_publish.topic == topic and prepared_publish.op_key == op_key and
         prepared_publish.payload == payload do
      prepared_publish
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_topic_deliveries!(prepared_publish, subscriptions) do
    prepared_targets =
      prepared_publish.deliveries
      |> Enum.map(&{&1.service_run_id, &1.signal_name})
      |> Enum.sort()

    current_targets =
      subscriptions
      |> Enum.map(&{&1["id"], &1["signal_name"]})
      |> Enum.sort()

    if prepared_targets == current_targets do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_topic_delivery!(prepared_publish, service_run_id, signal_name) do
    Enum.find(prepared_publish.deliveries, fn delivery ->
      delivery.service_run_id == service_run_id and delivery.signal_name == signal_name
    end) || Repo.rollback(:stale_cancellation_plan)
  end

  def subscribe_service_topic(lease_id, topic, signal_name) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with service_run when not is_nil(service_run) <-
             RunControl.get_fenced_run_by_lease(lease_id, now),
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
      with service_run when not is_nil(service_run) <-
             RunControl.get_fenced_run_by_lease(lease_id, now),
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
