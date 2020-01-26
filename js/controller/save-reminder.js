'use strict';

let $saveReminder = (function() {

	const MS_PER_DAY = 1000 * 60 * 60 * 24;
	const DAYS = 1;
	const CHECK_EVERY_K_MS = 1000;

	let modeReminding = false;

	function reminderToSave() {
		if ($unlock.getIsLocked() == true) {
			return;
		}
		if (modeReminding == true) {
			//do not have multiple alerts stack!
			return;
		}
		let now = Date.now();
		let lastReminder = localStorage.getItem('last-reminder');
		let lastSaveBackup = localStorage.getItem('last-save-backup');
		if (lastReminder == null) {
			localStorage.setItem('last-reminder', now.toString());
			return;
		}
		let intLastReminder = parseInt(lastReminder);
		let intLastSaveBackup = 0;
		if (lastSaveBackup != null) {
			intLastSaveBackup = parseInt(lastSaveBackup);
		}
		let lastReminderOrSave = Math.max(intLastReminder, intLastSaveBackup);
		let delayLastReminderOrSave = now - parseInt(lastReminderOrSave);
		if (delayLastReminderOrSave > DAYS * MS_PER_DAY) {
			localStorage.setItem('last-reminder', now.toString());
			let msg = "";
			let delayLastBackup = now - intLastSaveBackup;
			if (delayLastBackup > 0) {
				let duration = 'awhile';
				let days = 0;
				let hours = 0;
				let minutes = 0;
				let seconds = 0;
				let ms = 0;
				let total = delayLastBackup;
				while (total >= 1000 * 60 * 60 * 24) {
					days += 1;
					total -= 1000 * 60 * 60 * 24;
				}
				while (total >= 1000 * 60 * 60) {
					hours += 1;
					total -= 1000 * 60 * 60;
				}
				while (total >= 1000 * 60) {
					minutes += 1;
					total -= 1000 * 60;
				}
				while (total >= 1000) {
					seconds += 1;
					total -= 1000;
				}
				ms = total;
				//TODO: proper singular vs plural wording
				duration = `${days} days, ${hours} hours, ${minutes} minutes and ${seconds} seconds`;
				msg = "It has been "+duration+" since a backup was last saved. Would you like to save one now?";
			}
			else {
				msg = "Would you like to save a backup now?";
			}
			modeReminding = true;
			if (confirm(msg)) {
				$todo.actionSave();
			}
			modeReminding = false;
		}
	}

	setInterval(reminderToSave, CHECK_EVERY_K_MS);

})();