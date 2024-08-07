logo = '''
███╗   ███╗███████╗████████╗ █████╗ ██╗     ██╗███████╗████████╗
████╗ ████║██╔════╝╚══██╔══╝██╔══██╗██║     ██║██╔════╝╚══██╔══╝
██╔████╔██║█████╗     ██║   ███████║██║     ██║███████╗   ██║   
██║╚██╔╝██║██╔══╝     ██║   ██╔══██║██║     ██║╚════██║   ██║   
██║ ╚═╝ ██║███████╗   ██║   ██║  ██║███████╗██║███████║   ██║   
╚═╝     ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝╚══════╝   ╚═╝   
'''

version = '0.1'
db_dir = f'metalist.{version}'
default_db_name = 'metalist.db'
db_config_name = 'config.db'
host = '0.0.0.0'
port = 8080
reloader = True
development_mode = True  # TODO this should be argparsed
propagate_decorations = True
use_partial_tag_matches_positive = False
use_partial_tag_matches_negative = False
use_partial_text_matches_positive = True
use_partial_text_matches_negative = False
open_ai_url = 'https://api.openai.com/v1/chat/completions'
open_ai_model = 'gpt-4-0125-preview'
max_results = 50
always_add_to_global_top = True
outdent_all_siblings_below = True
inherit_text = True
max_tags_suggestions = 20
max_search_suggestions = 40
reset_undo_stack_on_search = True
simulated_lag_seconds = None
always_recalculate_ontology = True
reset_undo_stack_on_ontology_recalc = True
calculate_implications = False  # TODO this is just for testing some things out
