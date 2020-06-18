"use strict";

let $sidebar = (function() {

	const SHOW_EDITOR = true;

	let USE_CACHE = false;
	let cache = {};

	function updateSidebar(item, subitemIndex, mode_editing) {

		let subitem = null;
		let txt = '';
		if (item != null) {
			subitem = item.subitems[subitemIndex];
			txt = subitem.tags;
		}

		let items = $model.getFilteredItems();
		
		if (USE_CACHE && cache[txt] != undefined && subitem != null) {
			$('#div-side-panel').html(cache[txt]);
			return;
		}

		//ignoring mode_editing

		let html = '';

		html += '<table id="tbl-advanced" class="no-select"><tr>';

		if (SHOW_EDITOR && mode_editing) {
			html += '<td id="sidebar-editor-column" valign="top">';
			html += '<div style="color:black; font-weight:bold; padding-top:0px; margin-bottom:0px; font-size:large;">Editor</div>';
			html += '<hr class="sidebar-hr">';

			let hasChildren = $model.subitemHasChildren(item, subitem, subitemIndex);

			let tags = [];

			if (hasChildren) {
				tags.push({
					tag: META_LIST_BULLETED,
					action: 'action-toggle-list-bulleted',
					tooltip: 'Toggle @list-bulleted',
					display_name: 'bulleted list',
					button_content: '<span class="glyphicon glyphicon-list"></span>'
				});

				tags.push({
					tag: META_LIST_NUMBERED,
					action: 'action-toggle-list-numbered',
					tooltip: 'Toggle @list-numbered',
					display_name: 'numbered list',
					button_content: '<span class="glyphicon glyphicon-list-alt"></span>'
				});
			}

			tags.push({
				tag: META_TODO,
				action: 'action-toggle-todo',
				tooltip: 'Toggle @todo',
				display_name: 'todo',
				button_content: '<span class="glyphicon glyphicon-unchecked"></span>'
			});

			tags.push({
				tag: META_DONE,
				action: 'action-toggle-done',
				tooltip: 'Toggle @done',
				display_name: 'done',
				button_content: '<span class="glyphicon glyphicon-check"></span>'
			});

			tags.push({
				tag: META_BOLD,
				action: 'action-toggle-bold',
				tooltip: 'Toggle @bold',
				display_name: 'bold',
				button_content: '<span class="glyphicon glyphicon-bold"></span>'
			});

			tags.push({
				tag: META_ITALIC,
				action: 'action-toggle-italic',
				tooltip: 'Toggle @italic',
				display_name: 'italic',
				button_content: '<span class="glyphicon glyphicon-italic"></span>'
			});
				
			tags.push({
				tag: META_HEADING,
				action: 'action-toggle-heading',
				tooltip: 'Toggle @heading',
				display_name: 'heading',
				button_content: '<b>H</b>&nbsp;'
			});

			// TODO: removing for now until reimplemented better
			/*
			tags.push({
				tag: META_EMBED,
				action: 'action-make-link',
				tooltip: 'Toggle @embed',
				display_name: 'embed item',
				button_content: '<span class="glyphicon glyphicon-link"></span>'
			});
			*/

			tags.push({
				action: 'action-copy-subsection',
				tooltip: 'Copy action',
				display_name: 'copy',
				button_content: '<span class="glyphicon glyphicon-copy"></span>'
			});

			tags.push({
				action: 'action-paste-subsection',
				tooltip: 'Paste action',
				display_name: 'paste',
				button_content: '<span class="glyphicon glyphicon-paste"></span>'
			});

			tags.push({
				action: 'action-remove-formatting',
				tooltip: 'Remove formatting',
				display_name: 'unformat',
				button_content: '<span class="glyphicon glyphicon-ban-circle"></span>'
			});

			tags.push({
				action: 'action-split',
				tooltip: 'Split up cell into multiple',
				display_name: 'split cell',
				button_content: '<span class="glyphicon glyphicon-scissors"></span>'
			});

			tags.push({
				action: 'action-extract',
				tooltip: 'Extract subitem into separate item',
				display_name: 'extract',
				button_content: '<span class="glyphicon glyphicon-share-alt"></span>'
			});
			
			tags.push({
				tag: META_DATE_HEADLINE,
				action: 'action-toggle-date-headline',
				tooltip: 'Toggle @date-headline',
				display_name: 'display date',
				button_content: '<span class="glyphicon glyphicon-calendar"></span>'
			});

			for (let t of tags) {
				let color = '';
				let extraClass = '';
				if (t.tag != undefined && subitem != null && 
					(subitem._direct_tags.includes(t.tag) || 
					 subitem._implied_tags.includes(t.tag))) {
					color = 'white';
					extraClass = 'highlighted-format-option';
				}
				else {
					color = 'black';
				}
	            html += '<div style="margin:3px; font-weight:bold;">';
				html += '  <button type="button" title="'+t.tooltip+'" class="btn btn-default btn-sm '+t.action+' '+extraClass+'">';
	            html += '    '+t.button_content;
	            html += '  </button>&nbsp;&nbsp;<span style="color:'+color+';">'+t.display_name+'</span>';
	            html += '</div>';
			}

	        let dateValue = '';
	        if (item != null) {
	        	dateValue = formatDate(item);
	        }

	        html += '<div style="margin:6px;">';
	        html += '  <input style="width:135px;" type="date" class="time action-edit-time" size="5" value="' + dateValue + '"></input>';
	        html += '</div>';
			html += '</td>';
		}

		html += '<td id="sidebar-tags-column" valign="top" >';
		html += '<div style="color:black; font-weight:bold; padding-top:0px; margin-bottom:5px; font-size:large;">Tags and implications</div>';
		html += '<hr class="sidebar-hr">';
		html += '<div><canvas id="canvas-tags"></canvas></div>';

		let source = '';

		if (item != null) {

			///////////////////////////////////////////////////////////////////////////
			let basicImplications = $ontology.getBasicImplications();
			let implications = $ontology.getImplications();
			let handled_tags = [];
			let unhandled_tags = [];
			let tags = subitem._direct_tags.concat(subitem._inherited_tags);

			let all_tags_set = new Set();

			for (let tag of subitem._direct_tags) {
				all_tags_set.add(tag);
			}
			for (let tag of subitem._inherited_tags) {
				all_tags_set.add(tag);
			}
			if (subitem._attribute_tags != undefined) {
				for (let num of subitem._attribute_tags) {
					all_tags_set.add(num.split('=')[0]);
				}
			}

			let arr = Array.from(all_tags_set);
			for (let tag of arr) {
				if (implications[tag] != undefined) {
					for (let imp of implications[tag]) {
						all_tags_set.add(imp);
					}
				}
			}

			let full_arr = Array.from(all_tags_set);
			
			let equalities = {};
			for (let tag of full_arr) {
				if (equalities[tag] == undefined) {
					equalities[tag] = [tag];
				}
				if (implications[tag] == undefined) {
					continue;
				}
				for (let imp of implications[tag]) {
					if (implications[imp] == undefined) {
						continue;
					}
					if (implications[imp].includes(tag)) {
						if (equalities[tag].includes(imp)) {
							continue;
						}
						equalities[tag].push(imp);
						if (equalities[imp] == undefined) {
							equalities[imp] = [imp];
						}
						if (equalities[imp].includes(tag)) {
							continue;
						}
						equalities[imp].push(tag);
					}
				}
			}
			for (let key in equalities) {
				equalities[key].sort();
			}

			//TODO: handle attribute tags

			let rules = new Set();
			for (let tag of full_arr) {
				let tag_group = '['+equalities[tag].join(' | ')+']';
				let tag_head = equalities[tag][0];
				rules.add(tag_group);
				if (basicImplications[tag] != undefined) {
					for (let tag2 of basicImplications[tag]) {
						let tag_head2 = tag2;
						if (equalities[tag2] != undefined) {
							let tag_group2 = '['+equalities[tag2].join(' | ')+']';
							rules.add(tag_group2);
							tag_head2 = equalities[tag2][0];
						}

						if (equalities[tag_head].includes(tag_head2) == false) {
							rules.add('['+tag_head+']->['+tag_head2+']');
						}
					}
				}
			}

			if (Array.from(rules).length > 0) {
				for (let rule of Array.from(rules)) {
					source += rule + '\n';
				}

				source += '#edges: rounded\n'; //rounded | hard
				source += '#padding: 5\n'; //8
				source += '#spacing: 20\n'; //30
				source += '#bendSize: 1.5\n'; //0.3
				source += '#fillArrows: true\n'; //false
				source += '#fontSize: 11\n'; //10
				source += '#zoom: 0.75\n'; //1
				source += '#ranker: network-simplex\n'; //network-simplex | tight-tree | longest-path
				source += '#direction: right\n'; //right | down
				source += '#fill: #ffffff; #ffffff\n';
				source += '#lineWidth: 1\n';
			}

			///////////////////////////////////////////////////////////////////////////

			html += '</td>';

		}

		html += "</tr></table>";

		if (subitem != null) {
			cache[txt] = html;
		}

		$('#div-side-panel').html(html);

		if (source != '') {
			let canvas = document.getElementById('canvas-tags');
			try {
	            nomnoml.draw(canvas, source);
	        }
	        catch (e) {
	            console.error('Could not draw canvas.');
	        }
    	}
	}

	function clearSidebar() {
		updateSidebar(null, null, 0, false);
	}

	function formatTag(tag) {
		tag = '<span class="badge badge-light meta-tag">'+tag+'</span>';
		return tag;
	}

	function resetCache() {
		cache = {};
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar,
		resetCache: resetCache
	}

})();