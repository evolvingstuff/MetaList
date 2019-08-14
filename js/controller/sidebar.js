"use strict";

let $sidebar = (function() {

	/* This is currently a little broken */
	const SHOW_SIMILAR_ENTRIES = false; //TODO: turn this on when we have better notions of similarity

	const SHOW_EDITOR = true;

	let USE_CACHE = false;
	let cache = {};

	function updateSidebar(item, subitem, mode_editing) {

		let items = $model.getFilteredItems();

		let txt = JSON.stringify(item) + '/' + JSON.stringify(subitem);
		//console.log('DEBUG: ' + txt);
		
		if (USE_CACHE && cache[txt] != undefined && subitem != null) {
			//console.log('return cached sidebar');
			$('#div-side-panel').html(cache[txt]);
			return;
		}

		//ignoring mode_editing

		let html = '';

		html += '<table id="tbl-advanced" class="no-select"><tr>';

		if (SHOW_EDITOR && mode_editing) {
			html += '<td id="sidebar-editor-column" valign="top">';
			html += '<div style="color:white; font-weight:bold; padding-top:0px; margin-bottom:0px; font-size:large;">EDITOR</div>';

			html += '<hr class="sidebar-hr">';

			let tags = [
				{
					tag: '@todo',
					action: 'action-toggle-todo',
					tooltip: 'Toggle @todo',
					display_name: 'todo',
					button_content: '<span class="glyphicon glyphicon-unchecked"></span>'
				},
				{
					tag: '@done',
					action: 'action-toggle-done',
					tooltip: 'Toggle @done',
					display_name: 'done',
					button_content: '<span class="glyphicon glyphicon-check"></span>'
				},
				{
					tag: '@list-bulleted',
					action: 'action-toggle-list-bulleted',
					tooltip: 'Toggle @list-bulleted',
					display_name: 'bulleted list',
					button_content: '<span class="glyphicon glyphicon-list"></span>'
				},
				{
					tag: '@list-numbered',
					action: 'action-toggle-list-numbered',
					tooltip: 'Toggle @list-numbered',
					display_name: 'numbered list',
					button_content: '<span class="glyphicon glyphicon-list-alt"></span>'
				},
				{
					tag: '@code',
					action: 'action-toggle-code',
					tooltip: 'Toggle @code',
					display_name: 'code',
					button_content: '<span class="glyphicon glyphicon-console"></span>'
				},
				{
					tag: '@bold',
					action: 'action-toggle-bold',
					tooltip: 'Toggle @bold',
					display_name: 'bold',
					button_content: '<span class="glyphicon glyphicon-bold"></span>'
				},
				{
					tag: '@italic',
					action: 'action-toggle-italic',
					tooltip: 'Toggle @italic',
					display_name: 'italic',
					button_content: '<span class="glyphicon glyphicon-italic"></span>'
				},
				{
					tag: '@h1',
					action: 'action-toggle-h1',
					tooltip: 'Toggle @h1',
					display_name: 'headline 1',
					button_content: 'h1'
				},
				{
					tag: '@h2',
					action: 'action-toggle-h2',
					tooltip: 'Toggle @h2',
					display_name: 'headline 2',
					button_content: 'h2'
				},
				{
					tag: '@h3',
					action: 'action-toggle-h3',
					tooltip: 'Toggle @h3',
					display_name: 'headline 3',
					button_content: 'h3'
				},
				{
					tag: '@h4',
					action: 'action-toggle-h4',
					tooltip: 'Toggle @h4',
					display_name: 'headline 4',
					button_content: 'h4'
				},
				{
					tag: '@embed',
					action: 'action-make-link',
					tooltip: 'Toggle @embed',
					display_name: 'embed item',
					button_content: '<span class="glyphicon glyphicon-link"></span>'
				},
				{
					tag: '@copy',
					action: 'action-copy-subsection',
					tooltip: 'Toggle @copy',
					display_name: 'copy',
					button_content: '<span class="glyphicon glyphicon-copy"></span>'
				},
				{
					tag: '@paste',
					action: 'action-paste-subsection',
					tooltip: 'Toggle @paste',
					display_name: 'paste',
					button_content: '<span class="glyphicon glyphicon-paste"></span>'
				},
				{
					tag: '@date-headline',
					action: 'action-toggle-date-headline',
					tooltip: 'Toggle @date-headline',
					display_name: 'date headline',
					button_content: '<span class="glyphicon glyphicon-calendar"></span>'
				}
			];

			for (let t of tags) {
				let color = '';
				let extraClass = '';
				if (subitem != null && 
					(subitem._direct_tags.includes(t.tag) || 
					 subitem._implied_tags.includes(t.tag))) {
					color = 'white';
					extraClass = 'highlighted-format-option';
				}
				else {
					color = 'black';
				}
	            html += '<div style="margin:6px; font-weight:bold;">';
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

		html += '<div style="color:white; font-weight:bold; padding-top:0px; margin-bottom:5px; font-size:large;">TAGS</div>';

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
			if (subitem._numeric_tags != undefined) {
				for (let num of subitem._numeric_tags) {
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
			console.log('DEBUG: equalities = ' + equalities);
			let rules = new Set();
			for (let tag of full_arr) {
				let tag_group = '['+equalities[tag].join(' | ')+']';
				let tag_head = equalities[tag][0];
				console.log('tag: ' + tag + ' / ' + tag_group);
				rules.add(tag_group);
				console.log('\t'+tag_group);
				if (basicImplications[tag] != undefined) {
					for (let tag2 of basicImplications[tag]) {
						let tag_head2 = tag2;
						if (equalities[tag2] != undefined) {
							let tag_group2 = '['+equalities[tag2].join(' | ')+']';
							rules.add(tag_group2);
							tag_head2 = equalities[tag2][0];
							console.log('\ttag2: ' + tag2 + ' / ' + tag_group2);
						}
						else {
							console.log('\ttag2: ' + tag2 + ' / (no tag group)');
						}
						if (equalities[tag_head].includes(tag_head2) == false) {
							rules.add('['+tag_head+']->['+tag_head2+']');
							console.log('\t\t['+tag_head+']->['+tag_head2+']');
						}
					}
				}
			}
			console.log('------------------------------------------------');

			for (let rule of Array.from(rules)) {
				source += rule + '\n';
			}

			source += '#edges: rounded\n'; //rounded | hard
			source += '#padding: 8\n'; //8
			source += '#spacing: 30\n'; //40
			source += '#fontSize: 12\n'; //10
			source += '#zoom: 0.75\n'; //1
			source += '#ranker: network-simplex\n'; //network-simplex | tight-tree | longest-path
			source += '#direction: right'; //right | down

			///////////////////////////////////////////////////////////////////////////

			html += '</td>';


			//TODO: this code is currently a bit broken
			if (SHOW_SIMILAR_ENTRIES) {

				html += '<td valign="top">';

				html += '<div style="color:white; font-weight:bold; padding-top:0px; font-size:large;">Similar Entries</div>';

				let tot = 0;

				let start = Date.now();

				let matchGroups = {};

				allTags = subitem._tags.concat(subitem._implied_tags).concat(subitem._inherited_tags);

				let tiers = [];

				let MINIMUM_MATCHES = 1;

				for (let otherItem of items) {

					if (otherItem.deleted != undefined) {
						continue;
					}
					if (otherItem.id == item.id) {
						continue;
					}

					
					if (otherItem.subitems[0]._include != 1) {
						continue;
					}
					

					for (let i = 0; i < otherItem.subitems.length; i++) {
						let otherSubitem = otherItem.subitems[i];
						
						//TODO: handle private stuff better

						
						if (otherSubitem._include != 1) {
							continue;
						}
						
						
						let matches = 0;
						let otherAllTags = otherSubitem._tags.concat(otherSubitem._implied_tags).concat(otherSubitem._inherited_tags);

						let matched = [];

						for (let tag of allTags) {
							if (otherAllTags.includes(tag)) {
								if (matched.includes(tag) == false) {
									matched.push(tag);
								}
							}
						}
						tot += 1;

						if (matched.length == 0) {
							continue;
						}
						if (matchGroups[matched.length] == undefined) {
							matchGroups[matched.length] = [];
							tiers.push(matched.length);
						}
						matchGroups[matched.length].push(
							{
								otherItem:otherItem, 
								otherSubitem:otherSubitem, 
								subitem_index:i, 
								matched: matched
							});
					}
				}
				let end = Date.now();

				tiers.sort().reverse();

				let MAX_RESULTS = 100;
				let results = [];

				for (let tier of tiers) {
					if (tier < MINIMUM_MATCHES) {
						break;
					}
					let matchGroup = matchGroups[tier];
					matchGroup.sort(
						function(a, b) {
							return a.otherItem.priority - b.otherItem.priority;
						});
					let highest = 0;
					for (let entry of matchGroup) {
						if (entry.otherItem.priority < highest) {
							console.log('\tSORTING ERROR');
						}
						highest = entry.otherItem.priority;
						if (results.length >= MAX_RESULTS) {
							break;
						}
						results.push(entry);
					}
					if (results.length >= MAX_RESULTS) {
						break;
					}
				}

				let count = 0;

				for (let entry of results) {
					let text = $format.parse(entry.otherSubitem.data, entry.otherSubitem._direct_tags, entry.otherItem, entry.otherSubitem, entry.subitem_index);
					if (text.trim() != '') {
						let extra = '';
						if (count%2==0) {
							extra='background-color:#dddddd;'
						}
						html += '<div style="padding-left:2px; padding-top:4px; padding-bottom:4px; '+extra+' width:500px;overflow-wrap: break-word;">'+text+'</div>';
						
						html += '<hr style="color:white;">';

						count++;
					}
				}

				html += "</td>";
			}
		}

		html += "</tr></table>";

		if (subitem != null) {
			cache[txt] = html;
		}

		$('#div-side-panel').html(html);

		if (source != '') {
			let canvas = document.getElementById('canvas-tags');
			try {
				let t1 = Date.now();
	            nomnoml.draw(canvas, source);
	            let t2 = Date.now();
	            console.log('draw took ' + (t2-t1) + 'ms');
	        }
	        catch (e) {
	            console.log('Could not draw canvas.');
	        }
    	}
	}

	function clearSidebar() {
		updateSidebar(null, null, false);
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