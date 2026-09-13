"""Selected capture boundaries. New entries require review of operation and error types.

Unknown internal exceptions must propagate. This is deliberately separate from
syntax suppressions and is consumed by runtime capture and the startup gate.
"""

CAPTURE_BOUNDARIES = {
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:_delete_namespace_from_body:delete_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:namespace_delete_job_status:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:namespace_rename_job_status:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:open_login_namespace_route:launch_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:open_namespace:launch_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:rename_active_namespace:rename_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/auth.py:save_namespace_ports:save_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:_resolve_tab_sort_mode:capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:add_selected_text_tag:capture': ('SelectedTextTagValidationError',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:create_new_tab:capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:delete_tab:capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:update_tab_sort_mode:capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:update_tab_state:capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/notes.py:view_diff:capture': ('InputRejected',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/api/routes/reminders.py:_parse_date_field:capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/api/routes/reminders.py:_parse_datetime_field:capture': ('ValueError',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:_run_action:capture': ('ResourceNotFound', 'InputRejected'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:create_reminder:capture': ('ResourceNotFound', 'InputRejected'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:delete_reminder:capture': ('ResourceNotFound', 'InputRejected'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:evaluate_reminders:capture': ('ResourceNotFound', 'InputRejected'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:list_reminders:capture': ('ResourceNotFound', 'InputRejected'),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/reminders.py:update_reminder:capture': ('ResourceNotFound', 'InputRejected'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/api/routes/remote_images.py:proxy_remote_image:fetch_capture': ('RemoteImageFetchError',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/remote_images.py:proxy_remote_image:resolve_capture': ('ResourceNotFound',),
    # Translate explicitly validated domain input/resource rejection.
    'app/api/routes/remote_images.py:register_remote_images:registration_capture': ('InputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/main.py:namespace_deleted_open_page:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/main.py:namespace_deleted_open_page:launch_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/main.py:namespace_deleted_page:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/main.py:namespace_renamed_open_page:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Translate explicitly validated domain input/resource rejection.
    'app/main.py:namespace_renamed_page:job_record_capture': ('NamespaceInputRejected', 'FileNotFoundError'),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/security/request_boundary.py:_normalize_configured_hostname:normalize_capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/security/request_boundary.py:_normalize_hostname:ip_capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/security/request_boundary.py:_parse_host_header:parse_capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/security/request_boundary.py:_parse_origin:parse_capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/server_runtime.py:_detect_lan_ip:configured_ip_capture': ('ValueError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/server_runtime.py:_detect_lan_ip:parsed_ip_capture': ('ValueError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/server_runtime.py:_detect_lan_ip:probe_capture': ('OSError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/server_runtime.py:_detect_lan_ip:resolve_capture': ('OSError',),
    # Parse external host, URL, IP or date input at the named boundary.
    'app/server_runtime.py:_is_loopback_host:parse_capture': ('ValueError',),
    # Translate explicitly validated domain input/resource rejection.
    'app/server_runtime.py:_load_all_namespace_launch_profiles:validate_capture': ('NamespaceInputRejected',),
    # Translate explicitly validated domain input/resource rejection.
    'app/server_runtime.py:_parse_namespace_argument:namespace_capture': ('NamespaceInputRejected',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/latex_rendering.py:render_latex_math_to_html:conversion_capture': ('DenominatorNotFoundError', 'DoubleSubscriptsError', 'DoubleSuperscriptsError', 'ExtraLeftOrMissingRightError', 'InvalidAlignmentError', 'InvalidStyleForGenfracError', 'InvalidWidthError', 'LimitsMustFollowMathOperatorError', 'MissingEndError', 'MissingSuperScriptOrSubscriptError', 'NoAvailableTokensError', 'NumeratorNotFoundError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/latex_rendering.py:render_latex_to_html:segment_capture': ('DenominatorNotFoundError', 'DoubleSubscriptsError', 'DoubleSuperscriptsError', 'ExtraLeftOrMissingRightError', 'InvalidAlignmentError', 'InvalidStyleForGenfracError', 'InvalidWidthError', 'LimitsMustFollowMathOperatorError', 'MissingEndError', 'MissingSuperScriptOrSubscriptError', 'NoAvailableTokensError', 'NumeratorNotFoundError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/link_titles.py:_fetch_one_url:capture': ('TimeoutException', 'NetworkError', 'HTTPError', 'TimeoutException', 'NetworkError', 'ProtocolError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/link_titles.py:_resolve_public_http_target:capture': ('gaierror',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/link_titles.py:connect_tcp:connect_capture': ('ConnectError', 'ConnectTimeout'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/link_titles.py:fetch_link_title:target_capture': ('_LinkTitleTargetRejected',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/managed_ollama_runtime.py:_acquire_startup_lock:lock_capture': ('FileExistsError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/managed_ollama_runtime.py:_is_process_running:process_capture': ('ProcessLookupError', 'PermissionError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/managed_ollama_runtime.py:_probe_ollama_version:probe_capture': ('HTTPError', 'JSONDecodeError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/managed_ollama_runtime.py:_remove_stale_lock:missing_capture': ('FileNotFoundError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/managed_ollama_runtime.py:_remove_stale_lock:read_capture': ('FileNotFoundError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_deletion_worker.py:_is_process_running:kill_capture': ('ProcessLookupError', 'PermissionError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_deletion_worker.py:_send_signal_if_running:signal_capture': ('ProcessLookupError',),
    # Record operation failure and re-raise; never resume the failed operation.
    'app/services/namespace_deletion_worker.py:main:main_capture': ('Exception',),
    # Record operation failure and re-raise; never resume the failed operation.
    'app/services/namespace_rename_worker.py:main:main_capture': ('Exception',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_runtime_guard.py:inspect_namespace_runtime_legitimacy:database_capture': ('OSError', 'Error'),
    # Translate explicitly validated domain input/resource rejection.
    'app/services/namespace_switcher.py:_discover_namespaces:validate_capture': ('NamespaceInputRejected',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_is_process_running:kill_capture': ('ProcessLookupError', 'PermissionError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_is_tcp_port_open:connect_capture': ('OSError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_probe_namespace_status:decode_capture': ('UnicodeDecodeError', 'JSONDecodeError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_probe_namespace_status:request_capture': ('OSError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_read_namespace_launch_log_tail:read_capture': ('OSError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/namespace_switcher.py:_send_signal_if_running:signal_capture': ('ProcessLookupError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/remote_image_proxy.py:_download_one_url:request_capture': ('TimeoutException', 'NetworkError', 'HTTPError', 'TimeoutException', 'NetworkError', 'ProtocolError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/remote_image_proxy.py:_download_one_url:target_rejection_capture': ('_LinkTitleTargetRejected',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/remote_image_proxy.py:_validated_image_mime_type:validation_capture': ('DecompressionBombError', 'OSError', 'SyntaxError', 'UnidentifiedImageError', 'ValueError'),
    # Record operation failure and re-raise; never resume the failed operation.
    'app/services/self_update.py:_back_up_namespaces_before_update:backup_capture': ('OSError', 'Error', 'TarError', 'ValueError', 'RuntimeError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/shell_session_service.py:_monitor_run:wait_capture': ('TimeoutExpired',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'app/services/shell_session_service.py:_terminate_tree:capture': ('ProcessLookupError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'convert-from-legacy.py:_legacy_rule_is_currently_valid:parse_capture': ('OntologyParseError',),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'main.py:_is_process_running:kill_capture': ('ProcessLookupError', 'PermissionError'),
    # Handle expected external I/O, provider, image or LaTeX parsing failure.
    'main.py:_send_signal_if_running:signal_capture': ('ProcessLookupError',),
}
