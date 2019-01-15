let $sidebar = (function() {

	function updateSidebar(items, item, subitem) {
		if (item == null) {
			return;
		}
		html = '';

		html += '<table><tr><td valign="top" style="min-width:200px;">';

		html += '<div style="color:white; font-weight:bold; padding-top:0px; font-size:large;">Tags</div>';

		let all_tags = [];

		if (subitem._direct_tags != undefined && subitem._direct_tags.length > 0) {
			for (let tag of subitem._direct_tags) {
				all_tags.push(tag);
			}
		}
		if (subitem._numeric_tags != undefined && subitem._numeric_tags.length > 0) {
			for (let tag of subitem._numeric_tags) {
				all_tags.push(tag);
			}
		}
		if (subitem._implied_tags != undefined && subitem._implied_tags.length > 0) {
			for (let tag of subitem._implied_tags) {
				all_tags.push(tag);
			}
		}
		if (subitem._inherited_tags != undefined && subitem._inherited_tags.length > 0) {
			for (let tag of subitem._inherited_tags) {
				all_tags.push(tag);
			}
		}

		for (let tag of all_tags) {
			html += '<div>'+formatSomeTags(tag)+'</div>';
		}

		html += '</td>';

		html += '<td valign="top">';

		html += '<div style="color:white; font-weight:bold; padding-top:0px; font-size:large;">Similar Entries</div>';

		let tot = 0;

		let start = Date.now();

		let match_groups = {};

		all_tags = subitem._tags.concat(subitem._implied_tags);
		//all_tags = subitem._direct_tags;

		let tiers = [];

		for (let other_item of items) {
			if (other_item.deleted != undefined) {
				continue;
			}
			if (other_item.id == item.id) {
				continue;
			}
			//for (let other_subitem of other_item.subitems) {
			for (let i = 0; i < other_item.subitems.length; i++) {
				let other_subitem = other_item.subitems[i];
				if (other_subitem._include != 1) {
					continue;
				}
				let matches = 0;
				let other_all_tags = other_subitem._tags.concat(other_subitem._implied_tags);
				//let other_all_tags = other_subitem._direct_tags;
				for (let tag of all_tags) {
					if (other_all_tags.includes(tag)) {
						matches += 1;
					}
				}
				tot += 1;

				if (matches == 0) {
					continue;
				}
				if (match_groups[matches] == undefined) {
					match_groups[matches] = [];
					tiers.push(matches);
				}
				match_groups[matches].push({other_item: other_item, other_subitem: other_subitem, subitem_index: i});
			}
		}
		let end = Date.now();

		tiers.sort().reverse();

		let MAX_RESULTS = 100;
		let results = [];

		for (let tier of tiers) {
			let match_group = match_groups[tier];
			for (let other_subitem of match_group) {
				if (results.length >= MAX_RESULTS) {
					break;
				}
				results.push(other_subitem);
			}
			if (results.length >= MAX_RESULTS) {
				break;
			}
		}

		let count = 0;

		for (let entry of results) {
			/*
			let text = $format.textOnly(other_subitem.data);

			text = text.replace('&nbsp;', ' ');
			*/
			let text = $format.parse(entry.other_subitem.data, entry.other_subitem._direct_tags, entry.other_item, entry.other_subitem, entry.subitem_index);

			if (text.trim() != '') {
				let extra = '';
				if (count%2==0) {
					extra='background-color:#dddddd;'
				}
				//html += '<div style="color:black; font-style:italic; padding-left:2px; padding-top:4px; padding-bottom:4px; '+extra+' width:500px;overflow-wrap: break-word;">'+text+'</div>';
				html += '<div style="padding-left:2px; padding-top:4px; padding-bottom:4px; '+extra+' width:500px;overflow-wrap: break-word;">'+text+'</div>';
				count++;
			}
		}

		html += "</td></tr><table>";

		$('#div_side_panel').html(html);
	}

	function clearSidebar(filtered_items) {

		let html = '';
		html += '<div style="height:25px;"></div>';
		html += '<hr>';

		/*

		html += '<div style="color:white; font-weight:bold; padding-top:7px; font-size:large;">All Tags</div>';
		if (filtered_items != null) {
			let sorted_and_filtered = $model.getEnrichedAndSortedTagList(filtered_items, true);
			html += '<div style="width:40%; height:80%; float:left; overflow:scroll; position: relative;">';
			for (let tuple of sorted_and_filtered) {
				html += formatSomeTags(tuple.tag)+' ';
			}
			html += '</div>';
		}
		else {
			console.log('No items for sidebar');
		}
		*/

		//$('#div_side_panel').html(html);
		$('#div_side_panel').html('');
	}

	function formatSomeTags(tag) {
		if (tag == '@bold') {
			tag = '<span style="font-weight:bold;">'+tag+'</span>';
		}
		if (tag == '@italics') {
			tag = '<span style="font-style:italics;">'+tag+'</span>';
		}
		if (tag == '@green') {
			tag = '<span style="color:green;">'+tag+'</span>';
		}
		if (tag == '@blue') {
			tag = '<span style="color:blue;">'+tag+'</span>';
		}
		if (tag == '@red') {
			tag = '<span style="color:red;">'+tag+'</span>';
		}
		if (tag == '@grey') {
			tag = '<span style="color:grey;">'+tag+'</span>';
		}
		/*
		if (tag == '@h1') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h2') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h3') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@h4') {
			tag = '<span style="font-size:large;">'+tag+'</span>';
		}
		if (tag == '@meta') {
			tag = '<span class="badge badge-light">'+tag+'</span>';
		}
		if (tag == '@macro') {
			tag = '<span class="badge badge-primary" style="background-color:green;">'+tag+'</span>';
		}
		*/
		
		if (tag == '@todo') {
			tag = '<span><i class="glyphicon glyphicon-unchecked"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@done') {
			tag = '<span><i class="glyphicon glyphicon-check"></i>&nbsp;'+tag+'</span>';
		}
		/*
		if (tag == '@goto-search') {
			tag = '<i class="glyphicon glyphicon-link"></i>&nbsp;<span">'+tag+'</span>';
		}
		*/
		/*
		if (tag == '@code') {
			tag = '<span class="copyable"><code>'+tag+'</code></span>';
		}
		*/
		if (tag == '@fold') {
			tag = '<span><i class="glyphicon glyphicon-menu-up"></i>&nbsp;'+tag+'</span>';
		}
		if (tag == '@unfold') {
			tag = '<span><i class="glyphicon glyphicon-menu-down"></i>&nbsp;'+tag+'</span>';
		}
		
		/*
		if (tag == '@date-headline') {
			tag = '<span class="glyphicon glyphicon-calendar"></span>&nbsp;'+tag;
		}
		*/
		return tag;
	}

	return {
		updateSidebar: updateSidebar,
		clearSidebar: clearSidebar
	}

})();