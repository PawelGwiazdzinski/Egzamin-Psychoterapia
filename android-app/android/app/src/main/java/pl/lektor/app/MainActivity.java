package pl.lektor.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LektorPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
