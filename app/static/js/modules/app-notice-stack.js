// The bottom-right column that app notices (a new release, a backup reminder) float in,
// so that two notices stack instead of covering each other.

const STACK_ID = 'app-notice-stack';

export function appNoticeStack() {
    const existing = document.getElementById(STACK_ID);
    if (existing) {
        return existing;
    }
    const stack = document.createElement('div');
    stack.id = STACK_ID;
    stack.className = 'app-notice-stack';
    document.body.appendChild(stack);
    return stack;
}
