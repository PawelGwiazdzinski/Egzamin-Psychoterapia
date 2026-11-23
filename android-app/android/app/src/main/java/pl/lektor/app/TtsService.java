package pl.lektor.app;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.ServiceCompat;

/** Usługa pierwszoplanowa: utrzymuje czytanie przy wygaszonym ekranie i obsługuje przyciski powiadomienia. */
public class TtsService extends Service {
    static final String ACTION_START = "pl.lektor.app.START";
    static final String ACTION_PLAY = "pl.lektor.app.PLAY";
    static final String ACTION_PAUSE = "pl.lektor.app.PAUSE";
    static final String ACTION_NEXT = "pl.lektor.app.NEXT";
    static final String ACTION_PREV = "pl.lektor.app.PREV";
    static final String ACTION_STOP = "pl.lektor.app.STOP";

    static volatile boolean running;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Playback p = Playback.get(this);
        int type = Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        // Zawsze wchodzimy w tryb pierwszoplanowy (wymóg: do 5 s od startForegroundService).
        ServiceCompat.startForeground(this, Playback.NOTIFICATION_ID, p.buildNotification(), type);
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_PLAY.equals(action)) p.play();
        else if (ACTION_PAUSE.equals(action)) p.pause();
        else if (ACTION_NEXT.equals(action)) p.next();
        else if (ACTION_PREV.equals(action)) p.prev();
        else if (ACTION_STOP.equals(action)) {
            p.stop();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
