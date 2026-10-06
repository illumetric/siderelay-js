export type Consent = { analytics?: 'granted' | 'denied' | 'unknown'; advertising?: 'granted' | 'denied' | 'unknown'; personalization?: 'granted' | 'denied' | 'unknown'; source?: 'custom' | 'gcm_v2' | 'tcf_v2' | 'not_provided'; updated_at?: string; global_privacy_control?: boolean; sale_sharing_opt_out?: boolean; targeted_advertising_opt_out?: boolean };
export type Event = { event_id: string; event_name: string; occurred_at: string; environment?: 'development' | 'staging' | 'production'; consent?: Consent; identity?: Record<string, string>; context?: Record<string, unknown>; properties?: Record<string, unknown> };
export type Result = { status: 'received' | 'retry' | 'configuration'; message: 'Received' | 'Try again' | 'Check configuration'; code: string; attempts: number; httpStatus: number | null; acknowledgements: Record<string, unknown>[] };
export declare class SideRelay {
 constructor(options: { token: string; endpoint?: string; transport?: typeof fetch; sleep?: (milliseconds: number) => Promise<void>; timeoutMs?: number; maxAttempts?: number; timeBudgetMs?: number });
 track(event: Event): Promise<Result>;
 purchase(event: Omit<Event, 'event_name'>): Promise<Result>;
 lead(event: Omit<Event, 'event_name'>): Promise<Result>;
 batch(events: Event[]): Promise<Result>;
}
export declare function hashIdentity(value: string, type?: string): string;
export declare function normalizeEvent(event: Event): Event;
